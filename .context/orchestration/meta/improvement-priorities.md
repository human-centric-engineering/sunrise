# Orchestration Improvement Priorities

Prioritised improvements to the orchestration layer, scoped to the deployment profile Sunrise actually targets: **single-tenant, one instance per project, small engineering teams, small projects.**

**Last updated:** 2026-05-16 (Tier 8 added — proposed pre-launch foundation: reliability, operational trust, and partner-readiness; Tier 7 added earlier today — proposed lifecycle, integration, and operational-symmetry features; Tier 5 gained item 23a — production-conversation replay as the empirical complement to item 20)

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
| 6   | Named evaluation metrics (faithfulness, groundedness, relevance) | High          | Moderate     | ✅ Done           |
| 7   | Embed-widget customisation and theming                           | High          | Moderate     | ✅ Done (this PR) |
| 8   | Background / async execution model for long workflows            | Moderate–High | Moderate     | ✅ Done (PR #140) |
| 9   | Exact per-provider tokenisation                                  | Moderate–High | Low–Moderate | ✅ Done (this PR) |
| 10  | Built-in trace viewer / latency attribution improvements         | Moderate      | Moderate     | ✅ Done (this PR) |

### 6. Named evaluation metrics (faithfulness, groundedness, relevance) — ✅ Done

**Why it mattered.** Every venture-studio play in `business-applications.md` requires a domain expert to validate output before launch. The pre-existing LLM-completion handler produced a single opaque AI summary — fine for direction, useless as a defensible sign-off artefact or as a regression signal across KB / prompt / model changes.

**What changed in scoping.** Investigation surfaced a wiring gap: `AiEvaluationLog` rows were never written by any production code path (only by smoke tests). The runner UI sent `contextType: 'evaluation'` to the chat-stream endpoint, but the streaming handler only stored `contextType` on `AiConversation` — it never inserted log rows. So in production, completing a session hit `ValidationError: 'Evaluation session has no logs to analyse'`. The doc at `.context/admin/orchestration-evaluations.md:147` already documented the visible symptom (_"No transcript available."_). Item #6 had to fold in fixing that wiring — judge scoring needs something to score.

**What shipped (this PR).**

- **Eval-log mirroring.** When the chat handler runs in evaluation context, it now writes `AiEvaluationLog` rows alongside `AiMessage` rows: `user_input`, `ai_response`, `capability_call`, `capability_result`. Citations are snapshotted onto the `ai_response` log's `metadata.citations` so the judge sees what the answerer cited, frozen with the turn. Failures to write are logged at warn level and never abort the chat turn (same fire-and-forget posture as `logCost`).
- **Three named metrics.** `scoreResponse` calls a judge LLM once per `ai_response` log returning all three scores in a single structured-JSON response (cheaper than three calls, and the judge can reason about all three rubrics together). Faithfulness can be `null` when the answer carries no inline `[N]` markers; groundedness and relevance always produce a number in `[0, 1]`.
- **Schema.** Four nullable columns on `AiEvaluationLog` (`faithfulnessScore`, `groundednessScore`, `relevanceScore`, `judgeReasoning`) plus a `metricSummary` JSON column on `AiEvaluationSession`. Real columns for the scores so SQL aggregation across logs is cheap; reasoning lives in JSON because it's display-only. Migration is additive — no backfill.
- **Independent judge model.** `EVALUATION_JUDGE_PROVIDER` / `EVALUATION_JUDGE_MODEL` env vars (defaulting to `EVALUATION_DEFAULT_*`) so a Haiku-powered agent gets judged by a stronger model. Standard practice — judge ≥ subject.
- **Re-score endpoint.** `POST /evaluations/:id/rescore` lets admins re-run scoring after a KB update, prompt change, or judge swap. Overwrites scores in place; `metricSummary.totalScoringCostUsd` accumulates across runs. Gated on `status === 'completed'`.
- **Per-agent trend.** New `GET /agents/:id/evaluation-trend` returns sorted points (one per completed session). Powers a `recharts` `LineChart` on the agent detail page (mirrors the cost-trend-chart pattern; no new chart dependency).
- **UI surfaces (4).** Per-message F/G/R chips with colour scaling and a popover showing the judge's reasoning per metric. A "Quality" column on the evaluations list table (`F · G · R` per session, em-dash before scoring). A "Re-score" button on the completed view with confirmation dialog. A trend chart on the agent detail page (hidden when fewer than 2 completed evaluations).
- **Refactor opportunity taken.** Extracted `runStructuredCompletion` + `tryParseJson` from `complete-session.ts` into a shared `parse-structured.ts` helper, then used it from both call sites. Both the summary and the metric scorer now share one retry policy: temperature drops to 0 on retry, the malformed prior response is never included in the retry prompt, and tokens are summed across both attempts for accurate cost accounting.
- **Cost split without a new enum.** Both the summary and scoring calls log under `CostOperation.EVALUATION` but with `metadata.phase` set to `'summary'` or `'scoring'`. Analytics can split spend without a new enum value.

**Critical files (for reference):** `lib/orchestration/evaluations/score-response.ts`, `lib/orchestration/evaluations/parse-structured.ts`, `lib/orchestration/evaluations/complete-session.ts`, `lib/orchestration/chat/streaming-handler.ts` (the `writeEvaluationLog` private method), `prisma/migrations/20260503160012_evaluation_metrics/`, `app/api/v1/admin/orchestration/evaluations/[id]/rescore/`, `app/api/v1/admin/orchestration/agents/[id]/evaluation-trend/`, `components/admin/orchestration/evaluation-metric-chips.tsx`, `components/admin/orchestration/evaluation-trend-chart.tsx`, `.context/orchestration/evaluation-metrics.md` (canonical spec).

**Tradeoffs surfaced in the work.**

- Per-message scores are noisy below ~20 messages — interpret averages, not individual values. The runner UI surfaces this caveat; the trend chart caption repeats it.
- Re-score overwrites in place. No score history is retained. Versioned scoring is an additive future change if needed.
- Judge can itself be wrong. Reasoning text is always shown alongside the number so admins can spot judge errors. Standard mitigation; not solved by this PR.

### 7. Embed-widget customisation and theming — ✅ Done

**Why it mattered.** The trojan-horse model in `business-applications.md` repeatedly relies on dropping the agent into a partner's existing site — housing-association tenant portal, B&B concierge, council planning pre-screen, broker site, tattoo-studio enquiry agent, SaaS onboarding assistant. Pre-PR, every one of those deployments would have shown the same hard-coded blue bubble (`#2563eb`), the same English chrome ("Chat", "Type a message…", "Send", "Sources"), and the same system font stack. Partners cannot brand this. Maturity-analysis rated widget customisation **Adequate** vs. Dify/Flowise **Strong**, and partner sign-off correlates directly with this gap.

**What changed in scoping.** Two design forks resolved before the build:

- **Per-agent vs per-token.** A single `widgetConfig` JSON column on `AiAgent` shared by every embed token for that agent. Per-token override is an additive future change (move `widgetConfig` to `AiAgentEmbedToken` with agent-level fallback, or add `tokenWidgetOverrides`); chosen against now to ship smaller. Two partner sites sharing one agent will look identical until that follow-up.
- **No `locale` field.** The original framing mentioned locale as a knob. Pulling it in would have meant either a real i18n framework (translation tables for the widget chrome — nothing else in Sunrise needs one) or a system-prompt hint passed through the chat stream. Rejected both. Localisation is handled instead by admin-typed copy overrides — header, subtitle, placeholder, send button, conversation starters, footer — plus system instructions for the response language. Spanish UI = admin types Spanish into the copy fields; Spanish responses = admin adds it to system instructions. No new framework, no chat-stream wiring, ships smaller.

**What shipped (this PR).**

- **Schema.** One nullable `widgetConfig Json?` column on `AiAgent` (additive migration, no backfill). Defaults live in TypeScript via `DEFAULT_WIDGET_CONFIG` in `lib/validations/orchestration.ts`; the contract is explicit and centralised. `widgetConfigSchema` validates the resolved shape; `updateWidgetConfigSchema` is its `partial()` for PATCH bodies; `resolveWidgetConfig(stored)` merges defaults over the stored partial and falls back to defaults if the stored value is shape-invalid.
- **Public widget-config endpoint.** `GET /api/v1/embed/widget-config` — same `X-Embed-Token` auth + CORS treatment as the chat-stream route. Returns the resolved config so the loader can apply it without admin credentials. `apiLimiter` keyed by `${token}:${ip}`.
- **Admin endpoints.** `GET` (read resolved) and `PATCH` (partial update with from/to audit deltas under action `agent.widget_config.update`) at `/api/v1/admin/orchestration/agents/:id/widget-config`. PATCH validates the body via `updateWidgetConfigSchema`, merges over the current resolved config, persists the merged value, and returns the resolved config so the UI rebinds to the canonical shape.
- **Widget loader refactor.** The Shadow-DOM widget now fetches `/widget-config` on boot, merges the response over local `DEFAULTS`, and mounts. Inline `<style>` references CSS custom properties (`--sw-primary`, `--sw-surface`, `--sw-text`, `--sw-border`, `--sw-surface-muted`, `--sw-input-bg`, `--sw-status`, `--sw-font`); the loader assigns them on the host element after merge so a single property write cascades through the tree without re-templating CSS strings per agent. Copy is applied via `textContent` / `setAttribute('placeholder', …)` — admin-saved strings can never inject HTML into the partner page. Subtitle and footer rows hide themselves when their strings are empty. A new `.starters` row paints chip buttons before the first message; click → drops the chip text into the input and fires the same `send()` path; chips auto-hide on first message.
- **Defence-in-depth on inputs.** Colour fields validated as `^#[0-9a-fA-F]{6}$` before assignment. `fontFamily` validated by `^[\w\s,'"-]+$` — blocks `{`, `}`, `;`, parentheses so a stored font value cannot escape the CSS declaration. Length caps everywhere (header 60, subtitle 100, placeholder 80, send 30, footer 80, starters 4 × 200). The schema and the loader's defensive shape check together mean a corrupt stored value falls back to defaults rather than crashing the widget.
- **Admin UI.** The agent form's Embed tab now stacks two cards. Top: `<WidgetAppearanceSection>` — three native colour pickers paired with hex text inputs, font family, header title + subtitle, placeholder + send label, footer caption, conversation-starter list editor (add up to 4 chips, trash to remove), Reset to defaults, Save appearance. Layout splits into a form column and a static live-preview pane on the right at desktop widths so admins iterate on colours without saving and reloading a partner page. Every field has a `<FieldHelp>` popover with what / when / default per the contextual-help directive. Save scope is independent of the main agent form's dirty tracking — appearance saves immediately via its own button, mirroring the tokens card. Bottom: the existing `<TokensCard>` — token CRUD + copy `<script>` snippet, unchanged.
- **Tests.** 40 new tests landed across the schema (Zod hex/font/length/starter cap, partial-merge, `resolveWidgetConfig` fallbacks), the public endpoint (auth, CORS, defaults, merge, rate limit), the admin endpoint (auth gating, validation, audit row shape, resolved-config response), the widget loader (fetch path, fallback, CSS-var emission, copy substitution, starters lifecycle), and the appearance section (load, save, validation gating, starter add/remove, reset). The 18 existing `<EmbedConfigPanel>` tests had their `apiClient.get` mock dispatched to handle the new boot fetch.

**Critical files (for reference):** `lib/validations/orchestration.ts` (`widgetConfigSchema`, `updateWidgetConfigSchema`, `DEFAULT_WIDGET_CONFIG`, `resolveWidgetConfig`), `prisma/migrations/20260504082421_add_agent_widget_config/`, `app/api/v1/embed/widget-config/route.ts`, `app/api/v1/admin/orchestration/agents/[id]/widget-config/route.ts`, `app/api/v1/embed/widget.js/route.ts` (refactored), `components/admin/orchestration/agents/widget-appearance-section.tsx`, `components/admin/orchestration/agents/embed-config-panel.tsx` (composes appearance + tokens), `.context/orchestration/embed.md` (Widget customisation section).

**Tradeoffs surfaced in the work.**

- **Native colour picker.** `<input type="color">` ships across browsers but renders differently on Safari/iOS. Acceptable v1 — saves a dependency. If a future review wants polished pickers, swap in `react-colorful` (~3 KB) without schema change.
- **No live-on-partner-site preview.** The preview pane in admin is a static React mock that styles a frozen DOM with the in-form values. A genuine "see it on the actual site" preview would need an iframe-back-channel that's outside scope; admins can still drop the script tag into a scratch HTML file and reload to verify.
- **Per-agent skin only.** Two partner sites sharing one agent will look identical. Per-token override is an additive future change; chose against now to ship smaller. The schema layout (one column on `AiAgent`) is forward-compatible with a per-token override layer that defaults through to the agent column.
- **No iframe embed mode.** Maturity-analysis flags this separately as a different gap; not part of item 7. Shadow DOM remains the canonical embed.
- **No bubble icon / avatar upload.** Out of scope for v1 — that wants a storage capability (item 16) before it can land cleanly. Default chat-bubble emoji stays.

### 8. Background / async execution model for long workflows — ✅ Done

**Why it mattered.** Cron- and webhook-triggered workflows ran synchronously, fine for sub-60-second flows but problematic for patterns in business-applications: weekly council-spending ingestion, daily proactive churn outreach, scheduled regulatory-change monitoring, overnight research summarisation.

**What shipped (PR #140).** Non-blocking maintenance tick, lightweight execution status endpoint, live-poll status from the admin UI, `workflow.execution.failed` hook with engine-crash repair, sanitised hook payloads, liveness watchdog and token ownership on the maintenance tick.

**Critical files (for reference):** `lib/orchestration/engine/`, `lib/orchestration/scheduling/`, `app/api/v1/orchestration/maintenance/tick/`, `.context/orchestration/scheduling.md`.

### 9. Exact per-provider tokenisation — ✅ Done

**Why it mattered.** The 3.5-chars-per-token heuristic was load-bearing in two pre-flight decisions: (1) deciding what conversation history to drop before each chat turn so the request fits the model's context window, and (2) sizing chunks at knowledge upload time. The heuristic is fine for English prose but breaks badly on **code** (denser tokenisation than the heuristic predicts) and **non-English / CJK text** (much sparser characters-per-token than English). Multiple business-applications need this corrected — SEND advocacy, immigration support, crypto/regulatory whitepapers, council Hansard transcripts. Cost accounting was already accurate (providers report exact `usage.inputTokens` after the call) so this work scoped to the **pre-flight** path only.

**What changed in scoping.** The original framing proposed `tiktoken` (WASM) for OpenAI plus Anthropic's `count_tokens` API and Gemini's `countTokens()` SDK call. On review, the network-call options were rejected outright — adding 200–500 ms to every chat turn on the streaming hot path was unacceptable. WASM was rejected for adding bundler/CSP complexity without measurable speed wins at our string sizes. The scope simplified to: **synchronous and local tokenisers only**, exact for OpenAI (where a pure-JS encoder is free) and **calibrated approximations** for Anthropic / Gemini / Llama using `o200k_base` as the most non-English-friendly OpenAI encoding. The chunker's `chars / 4` heuristic stayed as-is — embedding-time chunk sizing tolerates more slack and embedding tokenisers differ from chat tokenisers.

**What shipped (this PR).**

- **`Tokeniser` interface + per-family variants.** `lib/orchestration/llm/tokeniser.ts` exports a synchronous `Tokeniser` contract with `id`, `exact`, and `count(text)`. Five concrete implementations: `OpenAiModernTokeniser` (o200k_base, exact), `OpenAiLegacyTokeniser` (cl100k_base, exact, used for `gpt-4` / `gpt-3.5` / `davinci`), `CalibratedTokeniser` (o200k_base × multiplier, used for Anthropic at 1.10, Gemini at 1.10, and Llama-family at 1.05), and `HeuristicTokeniser` (chars / 3.5 fallback).
- **`tokeniserForModel(modelId)` lookup with three-layer routing.** Layer 1 reads `provider` from the model registry and routes per family. Layer 2 falls back to model-id pattern matching (`claude-*` → Anthropic, `gpt-*` / `o1-*` / `o3-*` / `o4-*` → OpenAI, `gemini-*` → Gemini, `llama` / `mistral` / `qwen` substring → Llama-family) — covers two real cases the registry can't: brand-new ids the registry hasn't seen yet, and custom human-readable provider names like "OpenAI Production" whose lowercase form misses the `'openai'` enum. Layer 3 is the Llama-family approximator as a final default. Missing/null `modelId` falls back to the chars-only heuristic so legacy callers don't crash.
- **`gpt-tokenizer` dependency.** Pure JS, no WASM, ships both `o200k_base` and `cl100k_base` encoders. Sub-millisecond for typical chat history sizes.
- **`modelId` threaded through pre-flight truncation.** `estimateTokens(text, modelId?)`, `estimateMessagesTokens(messages, modelId?)`, and `truncateToTokenBudget(history, maxTokens, modelId?)` all gained an optional `modelId`. `BuildMessagesArgs` gained a `modelId` field. The streaming handler now passes `agent.model` in. With no model id supplied, every function still works via the heuristic — back-compat is total.
- **Honest precision.** Only OpenAI gets exact counts. The docs (`.context/orchestration/llm-providers.md`, "Tokenisation" section) call this out explicitly: Anthropic / Gemini / Llama are calibrated approximations, intentionally over-estimating so the failure mode is "drop a little more history than necessary" rather than "context-window overflow."
- **FieldHelp on the agent form.** The `Max history tokens` field on the agent advanced tab now explains that token counts are provider-tokeniser-aware, with a one-line note that exact counts apply only to OpenAI models.
- **48 tests.** 16 unit tests for the tokeniser module (routing, golden-string counts for o200k, calibration-multiplier ordering, fallback safety, all three layers including pattern matching for `claude-*` / `gpt-*` / `o1`–`o4` / `gemini-*` / Llama-family), 10 new cases on the token-estimator (modelId overload, CJK divergence, Anthropic >= OpenAI), 2 integration cases on `buildMessages` proving truncation behaviour differs across providers under the same budget.

**Critical files (for reference):** `lib/orchestration/llm/tokeniser.ts`, `lib/orchestration/chat/token-estimator.ts`, `lib/orchestration/chat/message-builder.ts`, `lib/orchestration/chat/streaming-handler.ts`, `tests/unit/lib/orchestration/llm/tokeniser.test.ts`, `tests/unit/lib/orchestration/chat/token-estimator.test.ts`, `tests/unit/lib/orchestration/chat/message-builder.test.ts`, `.context/orchestration/llm-providers.md` (Tokenisation section).

**Tradeoffs surfaced in the work.**

- **Calibration drift.** Multipliers are constants in `tokeniser.ts`, dated implicitly by their commit. Provider tokenisers do shift — Anthropic released a tokeniser update in 2024 that changed densities by single-digit percent. Recheck approach is documented inline in the tokeniser file and in `llm-providers.md`. A drift of ±10% is still ~5× better than the heuristic for non-English content.
- **No exact-pre-flight path for non-OpenAI.** A future feature wanting exact pre-call counts (e.g. budget enforcement before a long generation) can opt in to the network path independently — the abstraction supports adding async tokenisers later without changing the truncation hot path.
- **Chunker still uses the simple heuristic.** Documented as out of scope; embedding tokenisers don't match chat tokenisers and the chunker's failure mode is benign chunk-size drift rather than provider rejection.

### 10. Built-in trace viewer / latency attribution improvements — ✅ Done

**Why it mattered.** For single-tenant small projects, OTEL-to-Datadog integration (Tier 3 item 13) matters less than an in-product trace viewer. Maturity-analysis rated per-step latency attribution as "Weak" — admins debugging a workflow execution had a flat list of step rows with a single `durationMs` per row, no breakdown of LLM time vs. engine overhead vs. tool I/O, no aggregate view, no way to filter by failure or outlier, no per-call cost rollup for multi-turn executors. The data was largely there (`AiWorkflowExecution.executionTrace` JSON, `AiCostLog` rows joined by `workflowExecutionId`); the diagnostic value was bottled up because the UI never surfaced it and the engine never captured the per-step input or per-LLM-turn metadata that would make the surface useful.

**What changed in scoping.** Two design forks resolved before the build:

- **Where to store the new fields.** Considered a separate `AiTraceSpan` table for per-LLM-turn telemetry. Rejected — the JSON column already holds the per-step shape, and adding optional fields to `ExecutionTraceEntry` is back-compatible with historical rows (they parse cleanly, the UI just shows nothing extra). The `AiCostLog` join provides the per-LLM-call grain that multi-turn executors (`tool_call`, `agent_call`, `orchestrator`) need.
- **How telemetry flows through the engine.** Considered making each LLM-bearing executor return new fields on `StepResult`. Rejected — eight executors call into the LLM, and a future executor adding an LLM call would silently miss telemetry. Instead introduced an `LlmTelemetryEntry[]` accumulator on `ExecutionContext`. The engine pre-allocates a fresh array per snapshot via a new `telemetryOut` parameter on `snapshotContext` so concurrent parallel branches don't interleave. `runLlmCall` and `agent_call`'s `runSingleTurn` push one entry per `provider.chat()` call. The engine drains the array after each step and rolls the entries up into the trace entry's optional fields. New executors that hit the LLM through `runLlmCall` get telemetry for free.

OTEL/Langfuse/Datadog ingestion remains out of scope here — Tier 3 item 13 keeps that as a pluggable tracer for forks that need external observability.

**What shipped (this PR).**

- **Engine-side capture (Phase 1).** `ExecutionTraceEntry` gained six optional fields: `input` (snapshot of `step.config` at execution time), `model`, `provider`, `inputTokens`, `outputTokens`, `llmDurationMs`. `executionTraceEntrySchema` updated and is back-compatible with historical rows. `ExecutionContext.stepTelemetry?` is the new mutable write channel; `snapshotContext(ctx, telemetryOut?)` allocates per-snapshot arrays. `runStepWithStrategy` and `runStepToCompletion` thread a per-step telemetry buffer that resets between retry attempts so only the successful (or terminally-failed) attempt's data surfaces.
- **API enrichment (Phase 2).** `GET /executions/:id` now joins `AiCostLog` rows by `workflowExecutionId`, filters to those with a `metadata.stepId`, and returns a flat `costEntries[]` array. Multi-turn executors naturally produce several entries sharing a `stepId`; the UI groups client-side. Cross-user 404 short-circuits before the cost-log query so no timing/count signal leaks about another user's execution.
- **Aggregates card (Phase 3).** `ExecutionAggregates` renders step time sum (sum of per-step `durationMs` — labelled explicitly so it isn't confused with wall-clock), p50/p95 step duration (nearest-rank), slowest step (label + duration), LLM share (sum of `llmDurationMs` / step time sum), and a per-step-type breakdown (count · duration · tokens). Hidden when the trace has fewer than 2 entries — single-step traces have no aggregate to summarise.
- **Timeline strip (Phase 3).** `ExecutionTimelineStrip` renders one Gantt-style bar per step, widths proportional to the slowest step. Slow outliers (≥ p90 in traces with ≥ 5 entries) and failed bars are colour-coded; awaiting-approval bars are amber-striped. Click a bar → the parent scrolls and ring-highlights the matching trace row below. Hidden for single-step traces.
- **Per-step detail expansion (Phase 4).** `ExecutionTraceEntryRow` extended with: a `provider · model` chip in the header, a latency breakdown line ("LLM xxx ms · other yyy ms"), input/output side-by-side panels in the expanded body, a per-call cost sub-table populated from `costEntries[]` grouped by `stepId`, and a highlight ring when selected from the timeline strip.
- **Filter chips (Phase 4).** Six client-side filters above the trace list: All / Failed / Slow / LLM only / Tool only / With approvals. State is local to the view (not persisted to URL — single-tenant deployments don't need deep-linkable filtered traces). Filters that match zero entries are disabled and show their count.
- **Pure aggregate helper.** `lib/orchestration/trace/aggregate.ts` exports `rollupTelemetry`, `computeTraceAggregates`, and `slowOutlierThresholdMs`. Pure functions so the engine and the UI share one implementation, and edge cases (empty trace, single-entry trace, ties, missing optional fields) are exercised at source.
- **Tests.** 12 pure-function aggregate tests, 8 engine trace-capture tests, 4 schema back-compat tests, 1 llm-runner telemetry test, 1 agent-call telemetry test, 3 integration tests round-tripping through `executionTraceSchema`, 6 route-level tests for the cost-entries enrichment, 7 timeline-strip tests, 7 aggregates-card tests, 13 filter tests (pure + component), 9 trace-entry expansion tests covering model chip / latency breakdown / input-output / cost sub-table / highlight ring. Everything stays under the existing `npm run validate` (0 errors) and the 5421-test orchestration suite.

**Critical files (for reference):** `lib/orchestration/trace/aggregate.ts` (the new shared module), `lib/orchestration/engine/orchestration-engine.ts` (six trace.push sites, telemetry threading), `lib/orchestration/engine/context.ts` (`stepTelemetry?` + `snapshotContext` overload), `lib/orchestration/engine/llm-runner.ts` (`runLlmCall` push), `lib/orchestration/engine/executors/agent-call.ts` (per-turn push), `lib/validations/orchestration.ts` (`executionTraceEntrySchema` extension), `app/api/v1/admin/orchestration/executions/[id]/route.ts` (cost-log join), `components/admin/orchestration/execution-aggregates.tsx`, `components/admin/orchestration/execution-timeline-strip.tsx`, `components/admin/orchestration/execution-trace-filters.tsx`, `components/admin/orchestration/workflow-builder/execution-trace-entry.tsx`, `components/admin/orchestration/execution-detail-view.tsx`, `.context/orchestration/engine.md` (new optional fields documented), `.context/admin/orchestration-observability.md` (new viewer surfaces).

**Tradeoffs surfaced in the work.**

- **Last-turn wins for model/provider.** When a step issues multiple LLM calls (multi-turn executors), the rolled-up `model` / `provider` reflects the LAST turn. Workflows that mix models within a single `agent_call` (rare) will lose nuance — admins who care can drill into the per-call cost sub-table, which preserves the per-turn detail. Acceptable v1.
- **No prompt diff.** The plan flagged prompt-diff between runs as a stretch; deferred to a future opt-in flag. Capturing full prompts inflates the trace JSON significantly per execution and most workflows don't need it. The new `input` field stores `step.config` (interpolated prompts come from the cost log's separate trail).
- **Filter state is not URL-persisted.** Single-tenant deployments don't need deep-linkable filtered traces. If a future need (sharing a "look at the failed step" link with a colleague) comes up, query-string serialisation is a small additive change.
- **Slow-outlier highlighting needs ≥ 5 entries.** Highlighting outliers in a 3-step trace is statistical noise rather than insight. The threshold is documented inline in `slowOutlierThresholdMs`.
- **Aggregate `stepTimeSumMs` does not collapse parallel branches.** It sums all step durations, so parallel branches inflate the number above the actual wall-clock duration of the run. The card label was originally "Total wall" — renamed to "Step time sum" to remove the implication that this number is wall-clock. The Duration card up in the summary grid still shows the true wall-clock from `startedAt`/`completedAt`. The timeline strip's bar layout is the more honest visualisation when branches overlap.

---

## Tier 3 — Useful but lower priority for this profile

| #   | Improvement                                                    | Status  |
| --- | -------------------------------------------------------------- | ------- |
| 11  | Consumer-side (non-admin) approval flows in chat               | ✅ Done |
| 12  | Workflow definition versioning (publish/draft/rollback)        | ✅ Done |
| 13  | OTEL instrumentation as opt-in plug-in                         | ✅ Done |
| 14  | Inbound triggers from third-party systems (email-in, Slack-in) | ✅ Done |
| 15  | Better full checkpoint recovery beyond approval pauses         | ✅ Done |
| 16  | `upload_to_storage` capability (S3 / Vercel Blob)              | ✅ Done |
| 17  | Multipart/form-data construction in `lib/orchestration/http/`  | ✅ Done |
| 18  | Env-var resolution for binding `customConfig` at admin save    | ✅ Done |

Brief rationale for each:

### 11. Consumer-side approval flows in chat — ✅ Done

**Why it mattered.** Several business-application patterns — utility billing confirmation, e-commerce refund, planning pre-screening submission — need the **end user** themselves to confirm an action mid-conversation, not an admin from the queue. The HMAC token machinery already existed for external channels (Slack, email) but the chat surface couldn't render an Approve / Reject card — `requires_approval` failures from the capability dispatcher just surfaced to the LLM as tool errors with nothing actionable for the user.

**What changed in scoping.** Three architectural choices resolved the design before implementation:

1. **Workflow-bridged approvals, not capability-level.** Approvals route through workflow `human_approval` pauses rather than extending the capability dispatcher's `requires_approval` failure code. Reason: the HMAC token machinery is keyed on `executionId`, the audit trace is first-class for workflow executions, and extending the capability path would mean two parallel approval systems that inevitably drift. Side benefit: chat agents can now trigger workflows via the new `run_workflow` capability — useful beyond approvals.
2. **Carry-the-output-back, not resume-the-stream.** After the user clicks Approve, the chat client polls `GET /executions/:id/status` until the workflow completes, then submits a follow-up user message containing the workflow output so the LLM gets a fresh turn. The chat handler is structured around one user message → one assistant reply; re-entering it from a non-chat path would require per-conversation pub/sub that doesn't exist. The `approval_required` ChatEvent contract is forward-compatible if a future server-pushed implementation is added.
3. **Channel-specific sub-routes, not a body discriminator.** The chat-rendered Approve / Reject button hits new `…/approvals/:id/{approve,reject}/{chat,embed}` sub-routes. The server pins the `actorLabel` (`token:chat` / `token:embed` / `token:external`) on the route itself — never trusted from a body field. A leaked HMAC token can't be replayed under a misleading channel name in audit logs, and CORS scope differs cleanly per channel.

**What shipped.**

- New `run_workflow` capability (`lib/orchestration/capabilities/built-in/run-workflow.ts`) — args: `{ workflowSlug, input? }`. Per-agent binding requires `customConfig.allowedWorkflowSlugs` whitelist (fail-closed). Returns `{ status: 'pending_approval', executionId, stepId, prompt, expiresAt, approveToken, rejectToken }` with `skipFollowup: true` on pause; `{ status: 'completed', output, totalCostUsd, totalTokensUsed }` on synchronous completion. Workflow failure surfaces as a capability error so the LLM treats it as a tool failure rather than a sad-path success. Seeded as a system capability in `prisma/seeds/012-run-workflow.ts`; off-by-default for every agent.
- New `approval_required` SSE ChatEvent variant + `PendingApproval` interface in `types/orchestration.ts`. Streaming handler (`lib/orchestration/chat/streaming-handler.ts:extractPendingApproval`) emits the event after a paused `run_workflow` capability_result and persists a synthetic empty-content assistant message with `metadata.pendingApproval` set so reload restores the card from history. `done` follows the existing `skipFollowup` short-circuit; no LLM follow-up turn races the user click.
- Admin chat approval card (`components/admin/orchestration/chat/approval-card.tsx`) — full state machine (idle → submitting → waiting → completed / failed / expired), Approve / Reject with confirmation dialog, exponential-backoff polling on `GET /executions/:id`, synthesised follow-up message via `onResolved` so the LLM gets a fresh turn on approval.
- Embed widget approval card (`app/api/v1/embed/widget.js/route.ts:renderApprovalCard`) — Shadow-DOM safe, `createElement` + `textContent` only, inherits the per-agent theme via the existing `--sw-*` CSS custom properties from item 7. Approve / Reject submit to the channel-specific embed sub-routes; on a 200 the card polls the new `/status` endpoint and synthesises a follow-up via the existing input.value + send() path.
- Six new public routes:
  - `app/api/v1/orchestration/approvals/[id]/approve/{chat,embed}/route.ts` and the `reject` siblings — channel-pinned `actorLabel`, channel-specific CORS (same-origin for `/chat`, allowlist for `/embed`).
  - `app/api/v1/orchestration/approvals/[id]/status/route.ts` — token-authenticated execution status read with permissive CORS so the embed widget can poll from any partner origin.
- Shared route helper at `lib/orchestration/approval-route-helpers.ts` — refactor of the existing `/approve` and `/reject` route bodies; the legacy routes are now 5-line wrappers, the four new sub-routes share the same plumbing.
- Additive Prisma migration `20260506063640_add_embed_allowed_origins` — `embedAllowedOrigins: Json @default("[]")` on `AiOrchestrationSettings`. Settings hydration parses + filters to https / localhost URLs at read time so a corrupt setting can't crash the approval routes. Surfaced through the `OrchestrationSettings` type and admin settings UI.
- New audit `actor` values: `token:chat` and `token:embed` distinguish chat-confirmed from email/Slack-confirmed approvals.
- `.context/` updates: chat.md (In-chat approvals section), capabilities.md (`run_workflow`), embed.md (in-chat approvals + `embedAllowedOrigins`), orchestration-approvals.md (chat-rendered approvals + new actor values), and a new recipe `recipes/in-chat-approval.md`.

**Critical files (for reference):** `lib/orchestration/capabilities/built-in/run-workflow.ts`, `lib/orchestration/chat/streaming-handler.ts` (extractPendingApproval + emit site), `lib/orchestration/approval-route-helpers.ts`, `app/api/v1/orchestration/approvals/[id]/{approve,reject}/{chat,embed}/route.ts`, `app/api/v1/orchestration/approvals/[id]/status/route.ts`, `components/admin/orchestration/chat/approval-card.tsx`, `app/api/v1/embed/widget.js/route.ts` (renderApprovalCard), `types/orchestration.ts` (ChatEvent + MessageMetadata + PendingApproval), `prisma/migrations/20260506063640_add_embed_allowed_origins/`.

**Tradeoffs surfaced in the work.**

- **Capability-level (non-workflow) approvals — explicitly out of scope.** The dispatcher's existing `requires_approval` failure code stays admin-only. Could be added later additively if a partner needs in-chat approval on a single capability call without authoring a workflow first.
- **Embed status endpoint uses permissive CORS (`*`).** Token authentication is the gate — anyone with a valid HMAC token can read execution state, matching the threat model where the audience is the user themselves. Adding a per-origin allowlist would require coupling the HMAC token to an embed token (which it isn't today) and didn't earn its keep.
- **Reload recovery for the embed widget is degraded.** No embed-side messages-history endpoint exists today, so a hard reload of a partner page mid-approval doesn't restore the card from `metadata.pendingApproval`. The session-level case (SSE stream still open) is fine. Adding a token-authenticated history endpoint would close this gap; deferred until a partner asks for it.
- **The synthesised follow-up message is plain text.** A specialised "tool result" message-role would surface the workflow output more cleanly to the LLM, but that requires schema work. The current `"Workflow approved. Result: …"` user message is honest about what's happening and works on every existing model without prompt tuning.
- **12 — Workflow versioning.** ✅ Done. The pre-existing `workflowDefinitionHistory` JSON column was an audit trail bolted onto a live-edit model — every PATCH overwrote `workflowDefinition` and rollback was a destructive overwrite. Iteration was unsafe (a mid-edit save altered scheduled and webhook-triggered executions immediately) and per-execution provenance was missing. The replacement model has three pieces. (1) `AiWorkflowVersion` rows are immutable snapshots, monotonic per workflow, mirroring `AiAgentVersion`. `AiWorkflow` gains `publishedVersionId` (FK) + `draftDefinition` (nullable JSON); the legacy `workflowDefinition` and `workflowDefinitionHistory` columns are dropped. The migration backfills history entries oldest-first as v1..N then appends the current definition as vN+1, pinning `publishedVersionId` to it. (2) `AiWorkflowExecution.versionId` pins each execution to the snapshot it ran — `prepareWorkflowExecution` resolves the published version, validates the snapshot, and the engine stamps `versionId` on insert. Every entry point sets it: manual execute, scheduled tick, webhook trigger, `run_workflow` capability dispatch. Resume / pending-recovery paths prefer the pinned version on the row, with the workflow's current published version as a legacy fallback. (3) A new `version-service.ts` is the single mutation point — `saveDraft`, `discardDraft`, `publishDraft` (Zod + structural + semantic validation, atomic `$transaction`), `rollback` (creates a NEW version copied from target so the chain stays monotonic), `createInitialVersion`, `listVersions`, `getVersion`. Each mutation emits `workflow.draft.save` / `workflow.draft.discard` / `workflow.publish` / `workflow.rollback` audit entries. Five new admin routes (`/publish`, `/discard-draft`, `/rollback`, `/versions`, `/versions/:version`); PATCH writes to draft; POST creates v1 inside its create transaction; the legacy `/definition-revert` and `/definition-history` routes are deleted. The builder gets a status pill (`Editing draft` / `Up to date — vN published` / `No version published`), Save-draft + Publish… (with a `<PublishDialog>` that captures an optional 500-char `changeSummary`) + Discard-draft buttons, and the existing version-history panel is re-sourced from `/versions` with rollback wired to `/rollback`. Backup exporter/importer reseed v1 on import via `createInitialVersion`. Read-site sweep was mandatory before merge — every grep hit for `workflowDefinition\b` is now either a wire-format API field, a template-type property, or an error response key. Critical files: `prisma/schema.prisma` (`AiWorkflowVersion`), `prisma/migrations/20260506151928_add_workflow_versioning/`, `lib/orchestration/workflows/version-service.ts`, `lib/validations/orchestration.ts` (`publishWorkflowSchema`, `rollbackWorkflowSchema`), `app/api/v1/admin/orchestration/workflows/[id]/{publish,discard-draft,rollback,versions}/route.ts`, `app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers.ts`, `lib/orchestration/engine/orchestration-engine.ts` (versionId threading), `components/admin/orchestration/workflow-builder/{builder-toolbar,publish-dialog,workflow-builder}.tsx`, `.context/orchestration/workflow-versioning.md` (canonical doc).
- **13 — OTEL plug-in.** ✅ Done. A vendor-neutral `Tracer` interface in `lib/orchestration/tracing/` defaults to a no-op (zero allocations on the hot path, zero new deps for forks that don't enable tracing). Every LLM call site, capability dispatch, workflow step, agent-call turn, and chat turn is wrapped in an exception-safe span through `withSpan` (callback-shaped sites) or `withSpanGenerator` (async-generator-shaped sites: engine `execute()`, `workflow.step`, chat `run()`, streaming `llm.call`). Both helpers activate the span as the OTEL active context via `AsyncLocalStorage`, so nested spans propagate parent/child correlation end-to-end — OTLP backends render one trace per execution / chat turn rather than fragmented roots. Tracer failures are caught at the wrap boundary, logged at warn, and never abort orchestration. Span attributes follow OpenTelemetry GenAI semantic conventions (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, …) plus Sunrise extensions (`sunrise.execution_id`, `sunrise.step_id`, `sunrise.cost_usd`, `sunrise.provider.failover_from/to`, …). One first-party adapter ships: `OtelTracer` against `@opentelemetry/api`, opted into via `registerOtelTracer()` in a server-only init file. Forks point any OTLP-compatible backend (Datadog, Honeycomb, Grafana Tempo, Langfuse-via-OTLP) at the spans by configuring their own `TracerProvider`. Sampling delegates entirely to OTEL — Sunrise's interface has no sampling concept. `AiCostLog` rows gained nullable `traceId` / `spanId` columns so external trace backends can join cost data back to the originating span. Critical files: `lib/orchestration/tracing/`, `prisma/migrations/20260505141318_add_cost_log_trace_correlation/`, `.context/orchestration/tracing.md`.

### 14. Inbound triggers from third-party systems — ✅ Done

**Why it mattered.** Outbound coverage was good (webhook subscriptions, hooks, the `POST /api/v1/webhooks/trigger/:slug` API-key-auth path) but inbound from "things that happen elsewhere" was gappy. Several business-application examples (subscription-box churn outreach, mutual-aid coordination, complaints inbox) want email-in or Slack-in. The bar to clear was modest — the priorities entry framed it as "generic Postmark inbound parse covers most cases cheaply" — but the auth model didn't match the existing webhook trigger: Slack signs with a workspace signing secret, GitHub uses `X-Hub-Signature-256`, Postmark uses Basic auth, none send `Authorization: Bearer sk_…`. Per-vendor payload normalisation also matters so workflow templates can write `{{ trigger.from.email }}` without knowing Postmark's `FromFull.Email` shape.

**What changed in scoping.** Three architectural choices set the shape before implementation:

1. **OTEL plug-in pattern, not a Trigger admin entity.** The closest existing template was `lib/orchestration/tracing/` — a vendor-neutral interface (`Tracer`), a no-op default, and an opt-in first-party adapter (`OtelTracer`) that registers when env vars are present. Inbound mirrored that: `InboundAdapter` interface, env-driven self-registration via `bootstrapInboundAdapters()`, and three first-party adapters in-repo (`SlackAdapter`, `PostmarkAdapter`, `GenericHmacAdapter`). No admin UI for trigger CRUD in v1 — seed/migration only, matching the OTEL-style "wire it once" mental model. Multi-workspace Slack OAuth is **explicitly out of scope** for the same reason multi-backend exporter providers stay outside the OTEL adapter — that's the fork's TracerProvider equivalent.
2. **Single route family, not per-channel routes.** `POST /api/v1/inbound/:channel/:slug` is the single HTTP entry point; the route resolves the channel adapter from the registry, runs `handleHandshake` → `verify` → `normalise`, and inserts an `AiWorkflowExecution`. Channels with no env config remain unregistered and the route returns 404 — there is no "channel temporarily disabled" intermediate state, so probes can't distinguish "not configured" from "temporarily off". Mirrors how an unset `OTEL_EXPORTER_OTLP_ENDPOINT` produces no spans.
3. **Replay-protection model designed against an explicit threat model, not just "Slack retries".** The dedup column (`AiWorkflowExecution.dedupKey`) is computed per-channel: `<channel>:<externalId>` for shared-secret channels (slack, postmark) and `hmac:<workflowId>:<externalId>` for per-trigger HMAC. The split is load-bearing — Slack signs `v0:{ts}:{body}` without binding the URL, so a captured `event_id` replayed to a DIFFERENT workflow's URL would otherwise sail through; channel-global scope makes both inserts collide on the same key. Per-trigger HMAC channels don't share secrets across workflows, so per-workflow scope is correct (and lets unrelated triggers reuse the same eventId).

**What shipped.**

- **Three first-party adapters** under `lib/orchestration/inbound/adapters/`:
  - `SlackAdapter` (single-workspace) — verifies Slack's HMAC over `v0:{timestamp}:{rawBody}` per Slack's docs, ≤5min replay window, `url_verification` handshake echoing the `challenge` as plain text. Multi-workspace OAuth left for a future iteration.
  - `PostmarkAdapter` — Basic-auth check against `POSTMARK_INBOUND_USER` / `POSTMARK_INBOUND_PASS`, constant-time compare via `node:crypto.timingSafeEqual`, normalises `FromFull` / `ToFull` / attachments into a flat shape; attachments pass through with their base64 `Content` intact.
  - `GenericHmacAdapter` — reuses the outbound webhook scheme (`X-Sunrise-Signature: sha256=…` + `X-Sunrise-Timestamp`) via `verifyHookSignature`. Per-trigger `signingSecret` stored on the trigger row.
- **`lib/orchestration/inbound/`** module — `types.ts` (interface + `VerifyContext` + `NormalisedTriggerPayload`), `registry.ts` (singleton map + `getInboundAdapter` / `registerInboundAdapter` / `resetInboundAdapters`), `bootstrap.ts` (idempotent env-driven self-registration of the three adapters), barrel export.
- **`POST /api/v1/inbound/:channel/:slug`** route handler in `app/api/v1/inbound/[channel]/[slug]/route.ts` — handshake short-circuit, trigger lookup, `verify` defence-in-depth try/catch, optional `metadata.eventTypes` filter, channel-scoped `dedupKey` computation, P2002-on-`dedupKey` → 200 dedup ack, fire-and-forget `drainEngine` for instant dispatch. `inboundLimiter` (60 req/min per channel+IP) added to `lib/security/rate-limit.ts`.
- **Schema additions** on `AiWorkflowExecution`: `triggerSource VARCHAR(50)`, `triggerExternalId TEXT` (vendor attribution), `dedupKey TEXT` with `@@unique([dedupKey])`. New `AiWorkflowTrigger` model `(id, workflowId, channel, name, metadata, signingSecret, isEnabled, lastFiredAt, createdBy, …)` with `@@unique([channel, workflowId])`. Migration `20260507120000_add_inbound_triggers/migration.sql`.
- **Engine reuse**: `drainEngine` in `lib/orchestration/scheduling/scheduler.ts` was promoted from private to exported so the inbound route drains immediately instead of waiting for the next maintenance tick. Identical crash handling — uncaught engine errors mark the row FAILED, emit `workflow.execution.failed` hook, and dispatch the `execution_crashed` webhook.
- **Audit log**: every successful trigger fire writes `logAdminAction({action: 'workflow_trigger.fire', entityType: 'workflow_trigger', metadata: {channel, executionId, externalId, …}})`. The audit logger sanitises secret-named metadata fields automatically.
- **Critical files**: `lib/orchestration/inbound/{types,registry,bootstrap,index}.ts`, `lib/orchestration/inbound/adapters/{generic-hmac,postmark,slack}.ts`, `app/api/v1/inbound/[channel]/[slug]/route.ts`, `lib/orchestration/scheduling/scheduler.ts` (drainEngine export), `lib/security/rate-limit.ts` (inboundLimiter), `prisma/schema.prisma` + `prisma/migrations/20260507120000_add_inbound_triggers/`, `.context/orchestration/inbound-triggers.md` (canonical doc).
- **Tests**: 156 across 7 files (6 unit + 1 integration). Adapter unit tests use real `verifyHookSignature` rather than mocking — security-critical paths exercise the actual HMAC primitive end-to-end. Integration test mocks `@/lib/db/client` per project convention (no testcontainer setup ships) and asserts persistence via `expect(prismaMock.aiWorkflowExecution.create).toHaveBeenCalledWith(...)`.

**Tradeoffs surfaced in the work.**

- **Plaintext `signingSecret` storage on `AiWorkflowTrigger`** — mirrors the existing `AiEventHook.secret` pattern. HMAC needs the original secret on both sides, and Sunrise has no envelope-cipher infrastructure today. A future hardening would add field-level encryption gated on a master key in env, but it didn't earn its keep at the v1 single-tenant scale.
- **Dedup-scope branch is a magic-string check** (`channel === 'hmac'` in `route.ts`). A future fork that renames the HMAC channel slug or adds a new per-trigger-secret channel would need to update this branch — encoding the dedup model on the adapter itself (`adapter.dedupScope: 'channel' | 'workflow'`) would be more robust. Current implementation is correct for the three shipped adapters; the comment block above the conditional documents the contract for maintainers.
- **No multi-workspace Slack OAuth.** Single signing secret. Forks needing multi-workspace bind one Slack app per workspace and route each app to a different workflow URL. A first-class multi-workspace adapter (with bot-token storage, install flow, workspace-keyed secret resolution) would more than double the surface area of this feature; deferred until a partner asks.
- **No outbound Slack reply capability** in this PR. The trigger fires the workflow; if the workflow needs to reply to Slack, the fork wires a separate outbound capability (existing pattern via `external-calls` / a custom capability). Built-in Slack outbound is its own future item.
- **Postmark attachments stored inline as base64** on the execution row's `inputData`. Big attachments inflate the row but the existing `costLogRetentionDays` / conversation retention machinery prunes them on schedule. Forks that need durable binary storage chain `upload_to_storage` (item 16) early in the workflow and discard the inline data after.
- **Senders that omit `eventId` from generic-HMAC bodies get no event-level dedup** — only the 5-minute timestamp window protects them. Documented in the adapter docstring; the trade is "if you want dedup, signed-in eventId is the contract."

**Security review findings closed during the work.**

A `/security-review` pass surfaced two replay vectors that landed mid-development, both Medium severity:

1. **Generic-HMAC `X-Sunrise-Event-Id` header was unsigned.** An attacker capturing one valid signed request could replay it within the 5-min window by mutating the header on each call to bypass the `(workflowId, triggerExternalId)` unique. Closed by reading `eventId` / `eventType` from the SIGNED JSON body (`body.eventId`, `body.eventType`) — mutation invalidates the signature. The header is intentionally not supported on the inbound path; the docstring in `generic-hmac.ts` documents the security rationale.
2. **Cross-workflow Slack replay via shared signing secret.** Slack signs `v0:{ts}:{body}` without binding the URL; a captured Slack `event_id` replayed to a different workflow's URL would otherwise sail through. Closed by replacing the per-workflow `(workflowId, triggerExternalId)` unique with a `dedupKey String?` column + single `@@unique([dedupKey])`, where the route computes channel-global scope for shared-secret channels and per-trigger scope for HMAC. An integration regression test simulates the cross-workflow replay and asserts both legs produce the same `dedupKey`.

- **15 — Full checkpoint recovery beyond approval pauses.** ✅ Done. Pre-work, only `human_approval` pauses persisted enough state to resume cleanly — a crashed `RUNNING` row sat idle until the 30-min reaper marked it `FAILED`, losing all progress. Item 8 (background / async execution) made long-running profiles (scheduled cron, webhook-triggered, multi-minute orchestrator + agent_call chains) first-class, which made the recovery gap acute. Shipped across three PRs against the existing executor surface — no new HTTP routes, no UI surface. **PR 1 (lease + orphan sweep)** added `leaseToken` / `leaseExpiresAt` / `lastHeartbeatAt` / `recoveryAttempts` columns on `AiWorkflowExecution`, an atomic claim (`UPDATE … WHERE id=? AND (leaseToken IS NULL OR leaseExpiresAt < now())`), and a 60-s heartbeat timer that refreshes the lease across long single steps. The execution reaper grew a `sweepOrphans` pass ahead of the existing 30-min `FAILED` backstop: rows with `status='running' AND leaseExpiresAt < now()` are re-driven through the existing approval-resume path (`drainEngine(resumeFromExecutionId)`), capped at 3 attempts via `recoveryAttempts` then marked `FAILED` with `error.code = 'recovery_exhausted'`. A single-owner-event contract on lease loss (`finalize`/`pauseForApproval`/`checkpoint` all use `updateMany` with the lease guard and suppress downstream events on `count: 0`) means a stale host's terminal events never reach SSE subscribers. **PR 2 (dispatch cache + multi-turn checkpoint)** added `AiWorkflowStepDispatch` (UNIQUE on `idempotencyKey`, FK CASCADE) and three helpers in `dispatch-cache.ts` (`buildIdempotencyKey`, `lookupDispatch`, `recordDispatch` with P2002 race-loss handling). Three risky executors thread the cache: `external_call` auto-derives an `Idempotency-Key` HTTP header from the cache key (author override preserved), `send_notification` caches per-step, `tool_call` consults a new `isIdempotent` boolean on the capability registry (default `false` = cache active; `true` = bypass when destination handles re-run dedup naturally). Multi-turn checkpoint plumbing added a `currentStepTurns Json?` column plus a `TurnEntry` discriminated union (`agent_call` | `orchestrator` | `reflect`) and an engine surface (`ctx.recordTurn` / `ctx.resumeTurns`) so executors can record per-turn state and resume on the next turn after a crash. `reflect` short-circuits on `last.converged === true`, `orchestrator` on `lastPrior.finalAnswer`, `agent_call` single-turn on a terminal-phase last entry. `agent_call` multi-turn mode is **explicitly NOT supported** — it falls back to a fresh start on re-drive; the dispatch cache prevents inner side-effect duplication so the cost is only LLM tokens, not the side effect itself. Documented as a known limitation; revisit if multi-turn becomes load-bearing in practice. The retry-clear path (`runStepWithStrategy.onAttemptStart`) resets the in-memory accumulator + `currentStepTurns` between retry attempts so failed-attempt turns don't corrupt the next attempt's replay state. **PR 3 (AgentCallTurn sub-union)** closed a type-design-analyzer T1 finding deferred from PR 2: `AgentCallTurn.toolCall` and `.toolResult` were independently optional, allowing 4 type states for 2 valid runtime states. Split into `AgentCallTurnContinuing` (toolCall + toolResult required) and `AgentCallTurnTerminal` (both forbidden), discriminated by a literal `phase` field. Zod mirrors via `z.discriminatedUnion('phase', [...])`; the outer `turnEntrySchema` switched from `z.discriminatedUnion('kind', ...)` to `z.union(...)` because Zod can't nest discriminatedUnions as direct members. Executor narrows on `phase === 'continuing'` / `'terminal'` instead of `if (turn.toolCall)` field-presence. A `.catch(() => undefined)` on the `turns` field in `executionTraceEntrySchema` was added as backwards-compat insurance for forks running PR 2 in production: pre-PR-3 trace entries (no `phase` field) would otherwise fail to parse, get dropped by the resume `flatMap`, miss seeding into `visited`, and the DAG walker would re-execute the already-completed step. **Tradeoffs surfaced.** Mid-stream LLM-token checkpointing was explicitly out of scope (providers don't support resuming a generation, so saved partials are either semantically wrong or thrown away). Parallel-branch per-branch persistence was deferred until the multi-turn primitive shipped to see whether the same shape covers it. Distributed leases / leader election are Tier 4 (single-instance deployment profile). The default cache posture is `isIdempotent: false` — admins explicitly opt out for naturally-safe capabilities; a misconfigured `true` on a destructive capability is documented as the "you marked it idempotent" admin trade-off. **Critical files (consolidated):** `prisma/schema.prisma` (`AiWorkflowExecution` lease columns + `recoveryAttempts` + `currentStepTurns`; new `AiWorkflowStepDispatch`; `AiCapability.isIdempotent`), `prisma/migrations/{20260508080337_add_workflow_recovery_lease, 20260508114325_add_lease_pair_check, 20260508162706_add_workflow_step_dispatch, 20260508165225_add_multi_turn_checkpoint}/`, `lib/orchestration/engine/orchestration-engine.ts` (`claimLease`, `checkpoint` heartbeat, `recordStepTurn`, `executeSingleStep` plumbing, `runStepWithStrategy.onAttemptStart`, resume rehydration with the trace `.catch()` shim), `lib/orchestration/engine/lease.ts`, `lib/orchestration/engine/execution-reaper.ts` (`sweepOrphans`), `lib/orchestration/engine/dispatch-cache.ts`, `lib/orchestration/engine/context.ts` (`resumeTurns` / `recordTurn`), `lib/orchestration/engine/executors/{external-call,notification,tool-call,reflect,orchestrator,agent-call}.ts`, `lib/orchestration/capabilities/{dispatcher,types}.ts` (`isIdempotent` plumbing), `types/orchestration.ts` (`TurnEntry` + `AgentCallTurnContinuing | AgentCallTurnTerminal`), `lib/validations/orchestration.ts` (`turnEntrySchema`, `agentCallTurnSchema` discriminated union, `executionTraceEntrySchema.turns` `.catch()` shim), `.context/orchestration/engine.md` (Recovery model + Multi-turn checkpoint state sections), `.context/orchestration/workflows.md` (Idempotency and crash safety section), `.context/orchestration/recipes/long-running-workflow.md` (new recipe).
- **16 — `upload_to_storage` capability.** ✅ Done. Sunrise's pre-existing `lib/storage/` module (`StorageProvider` interface, S3 / Vercel Blob / local providers, `getStorageClient()` singleton with env-var auto-detect) supplied the entire engine — the new capability is a ~300-line wrapper. Per-agent `customConfig` controls `keyPrefix` (defaults `agent-uploads/<agentId>/`, traversal-checked via `validateStorageKey`), `allowedContentTypes` (case-insensitive per RFC 6838), `maxFileSizeBytes`, `signedUrlTtlSeconds` (S3-only — fail-closed on Vercel Blob/local with `signed_url_not_supported`), and `public`. Args are base64 `data` + `contentType` + optional `filename` — the LLM never controls the path: prefix is admin-set, filename is parsed for an extension only (`^\.[a-z0-9]{1,10}$`), and the path segment is a random UUID. Result returns `{ key, url, size, contentType, signed, expiresAt? }` so the LLM can hand the URL back and a future delete capability has the canonical key. The `recipes/document-render.md` recipe gained a "Pattern B" worked example showing the `call_external_api` → `upload_to_storage` chain alongside the original vendor-hosted-URL pattern; choice is framed by retention need, not implementation effort. **Bugs caught during the test pass:** (1) `Buffer.from('base64')` silently strips non-base64 chars — added strict-shape regex pre-check before decode; (2) `allowedContentTypes` was using literal `String.includes` against an MIME spec that's case-insensitive — both sides now lower-cased before comparison. Critical files: `lib/orchestration/capabilities/built-in/upload-to-storage.ts`, `prisma/seeds/013-upload-to-storage.ts`, `lib/orchestration/capabilities/registry.ts`, `tests/unit/lib/orchestration/capabilities/built-in/upload-to-storage.test.ts` (57 tests), `.context/orchestration/recipes/document-render.md`, `.context/orchestration/capabilities.md`.
- **17 — Multipart/form-data construction.** ✅ Done. Some hosted endpoints (Gotenberg HTML→PDF being canonical) require `multipart/form-data` with named file parts and field parts, not JSON. The HTTP module is now multipart-aware via a new pure-function module `lib/orchestration/http/multipart.ts` — exports a Zod-validated shape (`{ files: [{ name, filename?, contentType, data: base64 }], fields?: Record<string,string> }`) and a `buildMultipartBody(input)` that returns `FormData` with strict base64 validation, per-file (8 MB) and total-body (25 MB) caps, and bounded part counts. `HttpRequestOptions.body` was extended from `string` to `string | FormData`; when FormData, the JSON `Content-Type` default is suppressed so undici sets the boundary-bearing header itself. **HMAC + multipart rejected** with a new `multipart_hmac_unsupported` HttpErrorCode at the fetch entry point — multipart can't be signed deterministically (boundary varies, undici controls part ordering); failing closed is safer than signing the empty string and silently weakening the signature. Two call sites wired up: (a) `call_external_api` capability adds an LLM-facing `multipart` arg mutually exclusive with `body` (Zod refine); MultipartError is surfaced as `invalid_args`, multipart_hmac_unsupported as `invalid_binding` (the misconfiguration is the admin's auth choice, not the LLM call). (b) Workflow `external_call.config` adds a `multipart` field mutually exclusive with `bodyTemplate`; each `data` / `filename` / `contentType` / field value is interpolated against the execution context (`{{steps.x.body.data}}`) before the FormData is built. Out of scope: streaming construction (in-memory only — Sunrise's deployment profile doesn't need it; would require Readable plumbing through the entire HTTP path), async file fetching, and chunked / resumable uploads. The `recipes/document-render.md` Gotenberg variant is now a first-class supported path — no JSON-to-multipart adapter required. Critical files: `lib/orchestration/http/multipart.ts` (new), `lib/orchestration/http/fetch.ts` (body type + Content-Type skip + HMAC reject), `lib/orchestration/http/errors.ts` (new error code), `lib/orchestration/http/index.ts` (re-exports), `lib/orchestration/capabilities/built-in/call-external-api.ts` (args schema + multipart branch), `lib/orchestration/engine/executors/external-call.ts` (config schema + multipart branch + interpolation order), `lib/validations/orchestration.ts` (`externalCallConfigSchema` extension with `multipart` + mutual-exclusion refine), `.context/orchestration/external-calls.md` (Multipart bodies section + new error codes), `.context/orchestration/capabilities.md` (multipart note), `.context/orchestration/recipes/document-render.md` (Gotenberg promoted to first-class).
- **19 — Voice input (speech-to-text).** ✅ Done. Adds an opt-in microphone control to both chat surfaces — admin (`AgentTestChat`) and the third-party embed widget. Recorded audio is streamed to the configured audio-capable provider (e.g. OpenAI Whisper) and discarded after transcription; only the transcript becomes a normal user message. Two toggles gate the feature: per-agent `AiAgent.enableVoiceInput` (default off) and an org-wide `AiOrchestrationSettings.voiceInputGloballyEnabled` (default on). The widget-config endpoint additionally requires at least one audio-capable provider to be configured before exposing the mic button, so users never see a control that's guaranteed to error. **Why it mattered.** Mobile users dictating, accessibility for users who can't comfortably type, parity with end-user expectations from consumer AI products, and a step toward voice-first flows for partner integrations that don't have a keyboard surface (kiosks, automotive, smart speakers via embedding). **Routing.** Capability lookup, not `TaskIntent` extension — see ADR 3.7a. `LlmProvider.transcribe?(audio, options)` is optional; `OpenAiCompatibleProvider` implements it via `audio.transcriptions.create` so it works for OpenAI proper and any compatible host (Groq Whisper). `getAudioProvider()` filters `AiProviderModel` rows by `'audio'` capability. Anthropic-only deployments return `NO_AUDIO_PROVIDER` cleanly. **Cost tracking.** New `CostOperation = 'transcription'` writes per-row to `AiCostLog` with per-minute Whisper pricing (`WHISPER_USD_PER_MINUTE = 0.006`) computed from `durationMs`; tokens stay 0 and the duration is stamped into metadata for analytics. **Browser side.** Reusable `useVoiceRecording` hook owns `MediaRecorder` lifecycle (runtime MIME selection across Chrome/Firefox/Safari/iOS, 3-min client-side auto-stop matching the 25 MB server cap, accessibility labels, focus restore on transcript insertion). The embed widget mirrors the same state machine in plain ES5 inside the Shadow DOM. **Permissions-Policy.** Admin response headers ship `microphone=(self)`. The embed widget mounts on the partner site via `<script>` and inherits that site's policy — the platform cannot override it; a permission denial surfaces as "Microphone disabled by your browser or this site" inline rather than a generic error. Iframe embedders need `allow="microphone"`. **Tradeoffs.** Audio bytes are not retained — transcript-only storage is the privacy default; revisit if audit replay becomes a partner ask. Whisper pricing is hardcoded for v1 because it's the only audio model the platform routes to; promote to a `pricePerMinuteUsd` column on `AiProviderModel` when a second audio provider lands (Deepgram, ElevenLabs). Server-side audio-duration validation trusts `MediaRecorder`-reported duration; revisit if abuse is observed. **Critical files:** `lib/orchestration/llm/{provider,types,openai-compatible,provider-manager,cost-tracker}.ts`, `prisma/migrations/20260510080000_add_voice_input_settings/`, `app/api/v1/admin/orchestration/chat/transcribe/route.ts`, `app/api/v1/embed/speech-to-text/route.ts`, `app/api/v1/embed/widget-config/route.ts`, `app/api/v1/embed/widget.js/route.ts`, `lib/validations/transcribe.ts`, `lib/security/{rate-limit,headers}.ts`, `components/admin/orchestration/{agent-form,agent-test-chat}.tsx`, `components/admin/orchestration/chat/mic-button.tsx`, `lib/hooks/use-voice-recording.ts`, `.context/orchestration/{llm-providers,chat,embed}.md`, `.context/admin/agent-form.md`, `.context/api/{orchestration-endpoints,consumer-chat}.md`.
- **18 — Env-var resolution for binding `customConfig`.** ✅ Done. Stringy `customConfig` and workflow `external_call` step fields whose values are themselves credentials (Slack incoming-webhook URLs, literal `Authorization` headers) needed a way to stay in env vars rather than the DB. The `auth.secret` field already used the env-var-name pattern (`readSecret()` resolves `process.env[name]` at call time); item #18 extends that posture to four named fields: `call_external_api.forcedUrl` / `forcedHeaders`, and workflow `external_call.url` / `headers`. **Read-time, not write-time** — the literal `${env:VAR}` template stays in `customConfig` / step config, resolved on every call. Goal of "secret never in DB" is only met by read-time; rotation = change one env var, no binding edit; aligns with the existing fail-fast posture (missing env var → `invalid_binding` for the capability, `ExecutorError('missing_env_var')` for the workflow step). New `lib/orchestration/env-template.ts` module — pure functions (`containsEnvTemplate`, `extractEnvTemplateNames`, `resolveEnvTemplate`, `resolveEnvTemplatesInRecord`, `findUnsetEnvVarReferences`), strict pattern (`[A-Z][A-Z0-9_]*`) so a typo can't accidentally match. Schema relaxation on `forcedUrl`: previously `z.string().url()` rejected env templates; now accepts either a parseable URL or a string containing `${env:VAR}` references, with the resolved value re-checked for URL parseability at call time. Soft save-time warning on the binding API: `meta.warnings.missingEnvVars` lists every referenced env var not currently set in the running process; binding still saves so admins can deploy the var afterwards (mirrors `apiKeyPresent` for providers). UI: the agent Capabilities tab's Configure dialog renders missing names as an inline amber panel that clears on edit; the dialog had to switch from `apiClient.patch` to raw fetch + `parseApiResponse` because the apiClient unwraps response meta. The two narrow shapes the warning surface needs to scan — `customConfig` on the route side, `meta.warnings` on the dialog side — are validated with small Zod schemas (`bindingScanSchema`, `bindingMetaSchema`) rather than `as` casts, so a future server-side rename trips the parse instead of silently disabling the warning. Critical files: `lib/orchestration/env-template.ts`, `lib/orchestration/capabilities/built-in/call-external-api.ts`, `lib/orchestration/engine/executors/external-call.ts`, `app/api/v1/admin/orchestration/agents/[id]/capabilities/{route.ts,[capId]/route.ts}`, `components/admin/orchestration/agent-capabilities-tab.tsx`, `.context/orchestration/external-calls.md` (Env-var templating section + new `missing_env_var` error code), `.context/orchestration/capabilities.md` (templating note), `.context/orchestration/recipes/{chat-notification,transactional-email}.md`. Tradeoffs: kept scope narrow to four named fields (no generic deep-walk that would silently rewrite future contributors' strings); `auth.secret` left alone (already env-var-name; consistency would be churn-tax); workflow-builder publish-time validation surface deferred (admin form covers the binding case; workflow case lazy-fails through the existing error-strategy machinery).

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

## Tier 5 — Proposed: Graph-shaped agent enablement

A new category of improvements grounded in a single observation: **the way an agent is configured today is linear (a freeform text prompt), but the way an agent actually has to work is graph-shaped** — exploring, hitting dead ends, backing up, trying alternatives, and only converging when the constraints say it's safe to stop. Agents execute literally; they do not smooth over ambiguity the way humans do. Wherever the platform asks an agent to _infer_ what was meant from English prose instead of _check itself against an executable signal_, we leave latent quality on the table.

The execution layer is already graph-shaped — DAG workflows, `route`, `parallel`, `reflect`, `orchestrator`, conditional retries with `maxRetries` back-edges, human approval pauses — so the gap is not in how steps fire. The gap is in **what shapes the agent's behaviour and what it gets to feed back on**:

- Agent instructions are linear text. There is no structured way to express "these are the executable constraints the agent must satisfy" — only an English description the agent is asked to reconstruct correctly every call, on every model upgrade, across every fork.
- The `reflect` and `evaluate` steps are introspective: an LLM grading an LLM. They do not connect agent output to an external pass/fail signal (a test suite, a JSON-schema check, a synthetic-user run, a CI build).
- The feedback loops themselves are unobserved. If `reflect` quietly stops converging or `evaluate` scores drift downward as the corpus changes, no metric surfaces it — the same way flaky tests rot human teams, but with no green/red light to spot it.
- There is no first-class primitive for "try N approaches, suspend the unfinished ones, compare them, pick the best." `parallel` fans out and joins; it does not _select_.

Closing these gaps is what differentiates an agent platform that "kind of works most of the time" from one that holds its quality posture as the underlying models change. The four items below are the closure. They are ordered by leverage — item 20 unlocks the typing for the rest.

| #   | Improvement                                                               | Value     | Effort       | Status         |
| --- | ------------------------------------------------------------------------- | --------- | ------------ | -------------- |
| 20  | Executable behavioural specifications on agents                           | Very high | High         | ⚪ Not started |
| 21  | External-signal feedback — `run_check` capability + `reflect` integration | High      | Moderate     | ⚪ Not started |
| 22  | Feedback-loop health observability                                        | Moderate  | Low–Moderate | ⚪ Not started |
| 23  | `branch_and_select` step — explore-and-pick primitive                     | Moderate  | Moderate     | ⚪ Not started |
| 23a | Production-conversation replay against new agent versions                 | High      | Moderate     | ⚪ Not started |

> Item 23a was added 2026-05-16 as the empirical complement to item 20's synthetic-spec approach. The two answer different questions: item 20 asks "does the agent obey the spec on the scenarios authors wrote?"; item 23a asks "did the agent give a worse answer to the questions users actually asked after the model upgrade?" The full proposal sits at the end of this tier, after item 23.

### 20. Executable behavioural specifications on agents — ⚪ Not started

**Why it matters.** Today an agent's behaviour is shaped by a `systemPrompt` string and a set of bound capabilities. That works when the agent does narrow, well-bounded things. It breaks down the moment the agent has to make judgement calls — answering with the right tone, refusing the right topics, citing in the right format, returning structured data in a stable shape across model versions. The platform's response so far has been "tighten the prompt" and `output_guard`. Both are still inference: the agent has to _re-derive_ the contract from English every turn, and the guard fires after the fact rather than constraining the search space.

An executable specification flips that. Instead of (or alongside) a freeform prompt, each agent gets a **suite of behavioural assertions** stored as structured rows: scenario input, expected behaviour predicates, a category (refusal / format / tone / citation / tool-use), and a severity (blocking / warning). Predicates are concrete and machine-checkable — `output.matchesSchema(Z)`, `output.containsCitation()`, `output.refusedTopics(['legal advice'])`, `output.toneScore({faithful, polite}) >= 0.8`, `output.calledTool('search_knowledge_base')`, `output.length < 500`. A new `AiAgentBehaviourSpec` table is owned by the agent and versioned alongside `AiAgentVersion`, so a publish snapshots both the prompt and the spec atomically — drift between "what the agent is meant to do" and "what's deployed" stops being possible.

Two execution paths consume the spec:

1. **Pre-release validation.** A new "Behaviour" tab on the agent form runs every assertion against its bound test scenario on Save → Publish. Failing assertions either block publish or emit a publish-time warning (per-assertion severity flag), with a per-assertion diff: scenario, actual output, which predicate failed and how. This is the same shape as a unit-test suite, surfaced inside admin where it cannot rot in a separate repo.
2. **Inline runtime evaluation.** Each agent response (post-stream, fire-and-forget so it never blocks the chat reply) is scored against the predicates that apply to the runtime context — schema-shape and tool-call predicates apply universally; topic-refusal predicates apply only when the conversation matches a tag. Failures emit a `behaviour_violation` audit event and a new named metric on `AiEvaluationLog` so violations sit next to faithfulness / groundedness / relevance in the existing dashboards.

**UI shape.** A new tab on the Agent form ("Behaviour"), positioned between "Instructions" and "Capabilities". Empty state explains what behavioural assertions are and offers three starter packs (Refusal, Format, Tone) that seed common predicates. Each assertion row shows: scenario name, an inline editable test prompt, a category chip, a predicate builder (dropdown of predicate types → operand fields → expected value), and a per-row "Run now" button that exercises the assertion against the agent's current published prompt+capabilities, returning pass/fail + actual output inline. A summary strip at the top of the tab shows pass / fail counts and aggregate runtime, with one-click "Run all" before publishing. The conversation trace viewer gains a "Behavioural assertions" sub-panel per assistant message, showing which predicates were evaluated and their results — the same affordance as the existing citation-guard sub-panel, so admins learn one inspection pattern and reuse it.

**Benefits.**

- **Drift detection across model upgrades.** When a fork swaps GPT-4o for Claude 4.5 Sonnet, the suite either still passes or fingerprints what changed. Today that regression surfaces as user complaints.
- **A real "definition of done" for an agent.** The prompt becomes the implementation; the spec becomes the contract. New contributors can read the spec to know what the agent is _for_, not just how it's currently phrased.
- **Closes the authoring↔observability gap.** The same predicates that gate publish are the ones reported on in analytics, so the platform stops having one definition of "good" at publish time and a different one (faithfulness/groundedness/relevance) at runtime.
- **Shareable across forks.** Forks can ship libraries of predicates (a compliance pack for regulated domains, a tone pack for consumer-facing agents). A freeform prompt cannot carry that.
- **Backbone for items 21–23.** The structured contract becomes the natural argument shape for `run_check`, the natural unit of measurement for feedback-loop health, and a clean selector criterion for `branch_and_select`.

**Risks.**

- **Brittleness.** Predicates that are too strict flag every prompt change as a regression. Mitigation: ship semantic (LLM-judged) predicates for tone/style and structural (schema, tool-called, regex) predicates for the contract. Default starter packs lean structural.
- **LLM-judged predicates re-introduce the LLM-grades-LLM weakness.** Mitigation: prefer structural predicates where possible; require a reference example for every LLM-judged predicate so the judge has a calibration anchor; never let a single LLM-judged failure block publish (require N-of-M).
- **Adoption friction.** An empty Behaviour tab is worse than no tab — it shouts "more work to do." Mitigation: starter packs that seed five sensible predicates the moment the tab is opened, plus per-assertion "Run now" so admins see immediate feedback on whether their current prompt already satisfies the assertion.
- **Storage overhead.** Per-response runtime evaluation writes a row per applicable predicate per message. Mitigation: sampled evaluation (configurable, default 20% of messages once an agent crosses N requests/day), with always-on for the structural predicates that are cheap.

**Difficulty: High.** Schema work (`AiAgentBehaviourSpec` versioned alongside `AiAgentVersion`), a predicate evaluator with N built-in predicate types and a registration surface for custom ones, publish-time blocking + runtime scoring + audit events + new evaluation-log metric, a new tab on the agent form with a meaningful empty state and predicate builder, trace-viewer integration. Realistically two to three sprints.

### 21. External-signal feedback — `run_check` capability + `reflect` integration — ⚪ Not started

**Why it matters.** `reflect` today is LLM-grades-LLM: the same model that drafted the answer is asked whether the answer is good. That works for surface-level quality issues but is structurally weak for two cases — (a) anything where the truth lives in the world (does this SQL execute? does this code pass the tests? does this email parse as valid HTML? does this JSON match the downstream schema?), and (b) anything where the model is wrong in a way it is structurally unable to spot (a confident hallucination of a method signature, a refusal that should not have been a refusal). The fix is to make the feedback signal _external_: connect the agent's output to a runnable check whose pass/fail is determined by something other than another LLM call.

The shape is a new `run_check` system capability that takes `{ checkType, payload, config }` and returns `{ passed, signal, details? }`. The `checkType` discriminates: `'jsonSchema'` validates the payload against a Zod-encoded schema; `'regex'` runs a regex; `'httpProbe'` issues a request and checks the response shape; `'sqlExecute'` runs the SQL against a read-only sandbox connection (allowlisted per-agent via `customConfig`); `'shell'` (gated behind explicit opt-in env var, never default) runs a command in a sandboxed worker. Agents can call `run_check` directly inside a tool loop, but the higher-leverage path is wiring it into `reflect`: the executor gains a `checks: CheckSpec[]` option, and an iteration is only marked converged when _every_ check returns `passed: true` (or `maxIterations` is exhausted). The check signal — the actual error message, the failing schema path, the wrong row count — is fed into the next iteration's revision prompt so the agent knows specifically what to fix instead of being asked the vague "make this better" we ask today.

This is the missing half of the reflect loop. Today `reflect` asks "is this good?" and stops when the LLM says yes. With `checks`, it stops when something _external_ says yes — which is structurally different and structurally more reliable.

**UI shape.** Two surfaces. (1) The `reflect` step in the workflow builder gets a new "Checks" sub-section in its node config: a list with an "Add check" button, each check showing type (dropdown), the type-specific operand panel (Zod schema editor for `jsonSchema`, query box + read-only-DB picker for `sqlExecute`, URL + expected-status for `httpProbe`), and a per-check "Blocking / Soft" toggle. Soft checks appear in the revision prompt but do not gate convergence; blocking checks must all pass. (2) The trace viewer's `reflect` step expansion shows a check ledger per iteration: a row per check with name, pass/fail dot, runtime, and an on-hover detail panel showing the actual signal returned (schema diff, SQL error, HTTP response). This reuses the visual motif of the citation-guard sub-panel.

**Benefits.**

- **Closes the structural weakness of LLM-grades-LLM** for any case where ground truth exists outside the model. SQL queries that actually parse and return rows. JSON outputs that actually match the downstream consumer's schema. HTTP requests that actually reach a 200.
- **Removes the "model agrees with itself" failure mode** where reflect loops terminate at iteration 1 because the model is overconfident about its first draft.
- **Worked examples become first-class.** Code-generating, SQL-generating, and structured-data-extracting workflows can be expressed in the platform without custom executor work each time. Today these workflows are either built outside Sunrise or shipped with a fragile chain of `evaluate` → `route` glue.
- **Reduces tokens** spent on the LLM-judge half of `reflect` for cases where a schema or regex is cheaper and more reliable.
- **Composes with item 20.** A behavioural predicate like `output.matchesSchema(X)` is a `run_check`-flavoured object; the executor for both is the same evaluator. Building 20 makes 21 cheaper, and shipping 21 first makes 20's `output.*` predicates trivially implementable.

**Risks.**

- **Sandbox safety.** `shell` and `sqlExecute` introduce new attack surface. Mitigation: ship `jsonSchema`, `regex`, `httpProbe` first (no execution surface); gate `sqlExecute` behind a per-agent read-only allowlisted connection string with statement timeout and row cap; gate `shell` behind a global opt-in env var with documented threat model and a dedicated sandboxed worker process. The progression is value-ranked: 80% of the benefit is in the three non-executing types.
- **Over-use.** Not every reflect loop needs an external check. Documentation should frame `checks` as "when ground truth lives outside the model" and `evaluate` as "when the question is judgement-bound."
- **Check errors create false-failure loops.** A network blip on `httpProbe` could create an infinite revision loop if treated as `passed: false`. Mitigation: tri-state result — `passed` / `failed` / `errored`. `errored` short-circuits the reflect loop with a clear telemetry signal; it never silently masks as a quality failure.
- **Slow checks slow the loop.** A `sqlExecute` that takes 5s adds 5s × iterations to every run. Mitigation: per-check timeout (default 10s, configurable), surfaced in the trace's per-iteration latency strip.

**Difficulty: Moderate.** New `run_check` capability with N check types behind a registration surface, a `reflect` executor extension to plumb checks into convergence, workflow-builder UI for check config, trace-viewer surface, sandbox plumbing for the runnable types. The capability itself is one sprint; the SQL and shell sandboxes are the schedule risk and can be deferred without losing the structural win.

### 22. Feedback-loop health observability — ⚪ Not started

**Why it matters.** The platform has plenty of feedback loops — `reflect` iteration, `evaluate` scoring, retry back-edges with `maxRetries`, orchestrator re-planning rounds, citation-guard hits. None of them are themselves observed. If a `reflect` loop quietly stops converging across a week of executions, nothing surfaces it; the agent looks like it is working because every run _completes_, just at `maxIterations` instead of at genuine convergence. If `evaluate` scores drift downward as a corpus changes underneath, no metric trips. The execution-level metrics today are "did it succeed", "what did it cost", "how long" — none of which detect the slow erosion of the feedback layer itself.

This is the orchestration equivalent of flaky tests in a CI pipeline. Flaky tests don't fail the build until they do, and by the time they do, the team has already stopped trusting the suite. The pattern is identical: a feedback layer that's silently weakening still looks green from the outside.

Concretely, the work is three reportable signals on a new admin "Feedback health" dashboard:

1. **Reflect convergence rate** — per agent and per workflow step, what percentage of `reflect` invocations converged before `maxIterations`. A drop below the rolling baseline (configurable, default 80%) flags the agent.
2. **Evaluate score drift** — for each named metric (faithfulness, groundedness, relevance, plus the per-agent behavioural metric from item 20), a 7-day rolling average and its variance against the prior period. A statistically significant downward drift flags the agent.
3. **Retry exhaustion rate** — what percentage of steps with a `retry` error strategy hit the configured cap. A rising rate is the structural signature of a constraint that has become too strict, or an upstream capability that has degraded.

The raw data already exists. `reflect` emits per-iteration events; `AiEvaluationLog` stores per-response scores; retry attempts are captured in the execution trace's `retries[]` array. The work is the aggregation query, the dashboard, and the threshold-cross alerting hook (reuse the existing webhook hook dispatcher — emit `feedback.health.degraded` events that fork operators can route to Slack or PagerDuty).

**UI shape.** A new "Feedback health" page under Observability. Three cards across the top — Reflect Convergence, Evaluate Drift, Retry Exhaustion — each showing the 7-day rolling number, a sparkline, and a coloured chip (Healthy / Warning / Degraded). Below, a per-agent table sortable by any of the three columns, with a "Why?" link on each degraded row that drops into a filtered execution list showing the underlying failures. Threshold values live on the singleton `AiOrchestrationSettings` row alongside the existing budget thresholds, with sensible defaults and per-agent overrides for the small handful of agents that have legitimately different baselines.

**Benefits.**

- **Catches silent quality erosion** that no current dashboard surfaces — the slow drift that today only surfaces as user complaints.
- **Makes "is our feedback layer healthy?" a glance-able question** rather than an audit pass.
- **Closes the loop between the evaluation infrastructure and the operational view of it** — same data, different lens, no second source of truth.
- **Forces honest reckoning with `reflect` and `evaluate` defaults.** If a workflow's reflect step hits `maxIterations` 80% of the time, that's a design signal — either raise the iteration cap, lower the bar, or use item 21's external checks to get a more reliable convergence signal.

**Risks.**

- **Alert fatigue** if thresholds default too aggressive. Mitigation: conservative defaults (10% relative drop required to flag), require N consecutive samples below threshold, never page on a single data point.
- **Noisy per-agent baselines on low-traffic agents.** A pilot agent doing 30 requests/day has noisy stats. Mitigation: suppress the chip below a sample-size floor and surface "Insufficient data" explicitly rather than implying a false green.
- **Misinterpretation.** A high retry-exhaustion rate could mean an upstream provider degraded, not that the feedback loop itself is broken. Mitigation: the dashboard's "Why?" drilldown segments the failures by cause (provider failure, validation failure, timeout) so the operator reads the signal correctly.

**Difficulty: Low–Moderate.** Aggregation queries against already-captured data, one new dashboard page, settings-singleton threshold fields, hook event emission, drilldown filter routing. No new instrumentation — this is a presentation and alerting layer on top of what exists. One sprint.

### 23. `branch_and_select` step — explore-and-pick primitive — ⚪ Not started

**Why it matters.** A recurring pattern in graph-shaped agent work is: try several approaches in parallel, compare the results, pick the best, discard the rest. The platform has the ingredients — `parallel` fans out, `evaluate` scores, `route` directs — but no clean primitive to compose them. Today admins approximate it by chaining `parallel` → `evaluate` → `route`, which works but is verbose, fragile (the route condition has to interpolate the evaluate output with template strings that go wrong silently), and does not propagate cost or trace context cleanly. More importantly, it does not carry forward the _unselected_ branches' state in a way you can reason about — they just vanish, so debugging "why did we pick this draft when the other was clearly better?" is impossible without re-running.

A first-class `branch_and_select` step type takes `{ branches: StepSpec[], selector: SelectorSpec }`. The selector is one of: an LLM judge prompt with an explicit rubric; a numeric score derived from each branch's output (max/min); or a predicate (reuse `run_check` types from item 21 — pick the first branch that passes all checks). The step runs every branch in parallel (same engine path and `Promise.allSettled` plumbing as `parallel`), assembles the candidates, runs the selector, marks one branch's output as `selected`, persists the unselected candidates' outputs to `discardedBranches` on the step trace, and routes only the selected output downstream. Cost is the sum of all branches; the trace shows both the winner and the runners-up with a clear visual distinction.

This makes patterns like "try three drafts at different temperatures, ship the most cited one" or "ask three retrieval strategies and use whichever returned the source the user explicitly asked about" trivially expressible.

**UI shape.** New node type in the workflow-builder palette under "Composition", alongside `parallel`, `chain`, `route`. Drawer config: number-of-branches selector (2–6), per-branch sub-step picker (same UI as `parallel`'s branch list), selector-mode dropdown (LLM-judge / numeric / predicate), selector-mode-specific config below (rubric textarea for LLM-judge; output-path picker + max/min toggle for numeric; check list for predicate). Trace viewer renders the step as a fan-out / fan-in like `parallel`, but with the selected branch highlighted in the convergence node and the discarded branches rendered at `opacity: 0.4` with a tooltip explaining "this branch was not selected — selector reason: …". The execution aggregates card gains a "discarded cost" sub-stat showing what percentage of the run was spent on outputs that did not propagate.

**Benefits.**

- **Removes the multi-step boilerplate** for what is a genuinely common pattern. Authors write one step instead of three glued together with template-string fragility.
- **Preserves discarded-branch outputs for inspection.** Debugging "why this draft?" stops requiring a re-run. The trace tells you everything that was considered and why each runner-up lost.
- **Makes the engineering trade-off explicit.** "I am spending 3× to get the best of 3" is now visible in cost analytics rather than buried in a `parallel`-aggregate that does not flag the multiplier. Operators see the trade and decide whether it earned its keep.
- **Composes cleanly with items 20 and 21.** A predicate selector reuses `run_check` types directly; an LLM-judge selector with a rubric is itself a behavioural assertion in `branch_and_select` clothing. Each item makes the others naturally typed.

**Risks.**

- **Easy to over-use.** A `branch_and_select` is N× the cost of a single LLM call. If every step in a workflow uses one, cost explodes. Mitigation: the workflow validator warns when a workflow has more than two `branch_and_select` steps on the same path, and the cost analytics surfaces "discarded cost %" prominently on the workflow detail page so the trade is unmissable.
- **Selector quality bounds the step.** A bad LLM judge picks the wrong branch and the structural advantage of multiple candidates is wasted. Mitigation: encourage predicate selectors where possible; LLM-judge selectors always require a written rubric (the config UI refuses to save without one); add the rubric to the trace so it's auditable post-hoc.
- **Trace-row size growth.** Persisting discarded branch outputs grows the execution trace row. Mitigation: per-step `discardedBranches.maxBytes` cap that truncates outputs to head+tail; full outputs available via a separate paged API if the operator needs them.

**Difficulty: Moderate.** New executor (80% reuses `parallel`'s code path), new node type in the workflow-builder palette, trace-viewer surface for the discarded-branch view, validator integration, three selector implementations (LLM-judge, numeric, predicate). The selector machinery is the genuinely new code; the rest is composition. One sprint.

### 23a. Production-conversation replay against new agent versions — ⚪ Not started

**Why it matters.** Item 20 (executable behavioural specifications) tests an agent against the synthetic scenarios its authors thought to write — a known weakness of any test-suite-as-contract approach is that authors do not write tests for the questions they did not anticipate. The complement is to test against the questions users _actually asked_. When a partner pins an agent to a specific model and is later forced to migrate to a successor (deprecation, cost shift, capability win), the only signal that the upgrade is safe today is whatever specs the author wrote plus a vibe-check on a few recent conversations. This is structurally insufficient for the regulated-domain partners in `business-applications.md` — legal advisors, mortgage brokers, tenant-rights workers — whose answers have downstream consequences and whose real-user questions vary in ways the spec library cannot anticipate.

Replay closes this. Given a window of historical `AiConversation` rows and a target `AiAgentVersion`, the platform re-runs the user turns through the new version with a deterministic seed where the provider supports it, scores divergence on the new outputs using item 6's faithfulness/groundedness/relevance metrics, and returns a per-conversation divergence report a human reviews before approving the version transition. The empirical pair to item 20's synthetic-spec approach — both belong in the Tier 5 quality story, which is why this item slots inside Tier 5 rather than alongside Tier 7's integration work.

**What we'd ship.** A new `AiReplaySession` table linking `(sourceAgentVersionId, targetAgentVersionId, conversationWindow, status, divergenceSummary)`. A new admin route `POST /api/v1/admin/orchestration/agents/:id/replay` accepting `{ sourceVersionId, targetVersionId, conversationIds | { from, to, sampleSize } }`. The replay engine reuses `lib/orchestration/chat/` to re-walk user turns through the target version; system messages and tool-call sequences from the source run are excluded from the replay history (each new turn re-derives its own context from the conversation's user-side turns only). Per-turn scoring reuses the existing `lib/orchestration/evaluations/` pipeline; per-conversation divergence is the mean of per-turn metric deltas plus structural diffs (changed citations, changed tool calls, new refusals, changed refusals).

**UI shape.** A new "Replay" tab on the Agent form, positioned after the existing Versions tab. Empty state: a "Run replay against a new version" CTA with version-picker, conversation-window picker (last 7 days / 30 days / custom), and a sample-size slider (default 50 conversations). Running state: a progress bar with per-conversation status. Completion state: the divergence-report dashboard with three top-line metric-delta cards (mean faithfulness delta, mean groundedness delta, mean relevance delta) and a sortable conversation list. The trace viewer for each replayed conversation renders side-by-side using the same primitives as item 10 but with a "delta" column added. A one-click "Promote target version" button on the report header updates the agent's published version atomically; a per-conversation "revert window" surfaces if the divergence on a specific high-stakes conversation is unacceptable.

**Benefits.**

- **Catches model-upgrade regressions on real questions the spec library cannot anticipate** — the structural complement to item 20's synthetic coverage.
- **Decouples version-pinning from version-fear.** Today partners pin a version because they don't know what would change. Replay turns "I don't know what would change" into a divergence report.
- **Composes with item 35 (canary routing).** Replay is the offline divergence signal; canary is the live-traffic divergence signal. Same scoring machinery, two windows of evidence.
- **Reuses existing infrastructure end-to-end.** Chat handler, evaluation pipeline, trace viewer, agent-version model — all already there.

**Risks.**

- **Replay cost.** N conversations × M turns each × LLM cost per turn is non-trivial; a 500-conversation replay on a chatty agent could be a hundred-dollar test. Mitigation: configurable sample size (default 50), explicit cost preview before run, results cached per `(sourceVersion, targetVersion, conversationId)` so subsequent re-runs are free.
- **Deterministic-seed limitations.** Many LLM providers do not honour seeds reliably. Mitigation: divergence is reported as a band against a calibration baseline established by replaying the source version against itself; per-turn variance below the noise floor is reported as "no significant change."
- **Source-of-truth dilemma.** When the replayed answer is "different but arguably better," what does the admin do? Mitigation: divergence is reported, not gated — the report shows the new answer alongside the original with metric deltas; the human reads the trade.
- **Context drift.** If the source conversation depended on capabilities or KB chunks since deleted, replay either fails or runs against a different reality. Mitigation: replay validates that all source-referenced capabilities and KB chunks still exist before running; skipped conversations are reported with reasons.

**Difficulty: Moderate.** New table + new admin route + new engine module + new admin page + trace-viewer side-by-side mode. Reuses chat handler, evaluation pipeline, agent versioning. One sprint.

### Tier summary

The four items are not independent. Item 20 (executable specs) is the spine — once an agent's contract is a structured object, items 21 (`run_check`) and 22 (feedback health) become naturally typed by it: a behavioural assertion _is_ a `run_check`-shaped object; a behavioural assertion failure _is_ the same health signal as a reflect non-convergence. Item 23 (`branch_and_select`) is the most architecturally independent but composes cleanly with the others — predicate selectors reuse `run_check` types, LLM-judge selectors are bounded behavioural-spec rubrics.

Sequenced: **20 → 21 → 22 → 23**, with 23 reorderable forward if a specific pilot needs a structured "try three drafts, pick one" pattern. Items 21 and 22 are individually shippable as standalone wins; item 20 is the high-value, high-effort spine and is most worth doing first if a multi-sprint slot is available.

The combined effect: agents stop being freeform-text prompts judged by another freeform LLM, and become structured objects whose contract is checkable, whose feedback is observable, and whose alternatives are first-class. That is the difference between an agent platform that "kind of works most of the time" and one that holds its quality posture as the underlying models change.

Item 23a — production-conversation replay — was added later as the empirical complement to item 20. Where item 20 tests the agent against the synthetic scenarios authors thought to write, item 23a tests it against the questions users actually asked. Both belong in the Tier 5 quality story; the synthetic side gives coverage of intent, the empirical side gives coverage of reality. Slot 23a after items 20 and 22 in the sequencing — item 20 provides the predicate language replay's per-turn divergence scoring extends, and item 22 provides the dashboard surface where replay results most naturally land.

---

## Tier 6 — Proposed: channel reach, conversational surface, and operational trust

A second category of proposed work emerging from the voice-input and vision-input arc that shipped earlier this month. Where Tier 5 deepens **what an agent is** (structured contracts, external feedback, observability of the feedback layer), Tier 6 widens **where the agent reaches** and **how the conversation feels**. Two observations frame the shape:

- **Most of the audiences in `business-applications.md` are not on a desktop browser.** Tenant-rights enquirers, mutual-aid coordinators, proactive churn-outreach recipients, complaint authors — these people live in WhatsApp, SMS, and email threads. The embed widget structurally cannot reach them; they have to find the right page on the right partner site and start typing. Meeting them on the channel they already check removes that activation bar.
- **Conversations carry weight that the chat UX does not yet honour.** A pre-application chat with a council, a legal-rights consultation, a financial-planning back-and-forth, a complaint thread — each one is an artefact the partner or the end user will want to share, export, hand off, or pick up later. The current chat UI treats every conversation as ephemeral and free-text-only, which leaves partner-facing value on the table.

Items 24 and 25 close the channel-reach gap. Items 26 and 27 raise the conversational surface from "free text only" to "free text + structured affordances + portable artefact." Item 28 closes the trust loop by giving partners an explicit consumer-side human-in-the-loop when the agent's confidence isn't enough.

| #   | Improvement                                               | Value         | Effort        | Status         |
| --- | --------------------------------------------------------- | ------------- | ------------- | -------------- |
| 24  | WhatsApp / SMS channel (Twilio + WhatsApp Cloud adapters) | Very high     | Moderate      | ⚪ Not started |
| 25  | Email-out conversation thread                             | High          | Low–Moderate  | ⚪ Not started |
| 26  | In-chat structured affordances (cards, forms, charts)     | High          | Moderate–High | ⚪ Not started |
| 27  | Conversation export / share (PDF or signed link)          | Moderate–High | Low–Moderate  | ⚪ Not started |
| 28  | Live agent handover ("talk to a human")                   | High          | Moderate      | ⚪ Not started |

### 24. WhatsApp / SMS channel (Twilio + WhatsApp Cloud adapters) — ⚪ Not started

**Why it matters.** The proactive-outreach, customer-experience, mutual-aid, and tenant-rights subcategories in `business-applications.md` describe audiences that overwhelmingly live in WhatsApp and SMS, not on partner websites. Today, the only consumer surface is the embed widget — which requires a user to actively visit a page, accept whatever chat affordance the partner site exposes, and start typing. WhatsApp and SMS invert that posture: a known user is reached in the channel they already check, and the conversation can begin because the platform initiated it (or because the user texted back a saved number). The activation bar drops from "find the right page on the right site" to "open the app you already had open." For partner pilots in regulated or under-served verticals, this is the difference between a feature that demos well and a feature that drives weekly-active conversations.

**What we'd ship.** Two first-party `InboundAdapter` implementations under `lib/orchestration/inbound/adapters/`. (1) `TwilioAdapter` for SMS and Twilio-routed WhatsApp — verifies the `X-Twilio-Signature` header (HMAC over the URL plus sorted POST params, Twilio's documented scheme), normalises the form-encoded body into the same flat shape as Slack and Postmark (`from`, `text`, `channel`, optional `attachments[]` resolved from `MediaUrlN` fields). (2) `WhatsAppCloudAdapter` for Meta-direct WhatsApp Business — verifies via `X-Hub-Signature-256` (same scheme as GitHub and our generic-HMAC adapter), normalises the nested webhook shape, handles the verification GET handshake. Plus one outbound capability — `send_message_to_channel` — that resolves the target channel from the conversation's recorded inbound origin, so a single workflow replies on whichever channel the user reached us on (SMS, WhatsApp, Postmark email all become first-class without per-channel branching). Conversations key on `(channel, fromAddress)` so persistent memory and citation history survive across SMS turns the way they do in chat. One worked recipe covers inbound triage → reply for both SMS and WhatsApp, with the WhatsApp 24-hour conversation window and template-message rules flagged honestly.

**Benefits.** Unlocks the WhatsApp-first and SMS-first audiences the embed widget structurally cannot reach. Reuses the entire inbound-triggers framework (item 14) for verification, rate limiting, audit, and dedup — no new security surface beyond two adapter implementations. Pairs with vision input (just shipped) for MMS image messages, so a user can text a photo of a council notice and get back grounded advice over the same channel. The same workflows that drive embed-widget conversations work over WhatsApp without rewriting — channel becomes a routing concern, not a workflow concern.

**Risks.** The 24-hour WhatsApp conversation window means an unsolicited outbound reply outside that window must be a pre-approved Meta template — there is no way around this and it is a frequent surprise for partners. Mitigation: ship a recipe walking through Meta template approval and a small starter set of templates aligned to the worked examples (appointment reminder, follow-up nudge, action-required). Twilio's price-per-message is non-trivial at scale — cost dashboards need a per-channel breakdown so partners can see WhatsApp / SMS spend separately from LLM spend. MMS media attachments require Basic-auth fetches against Twilio — wired through the existing HTTP fetcher's auth modes rather than baked into the adapter.

**Difficulty: Moderate.** Two adapters mirror the shape of the three existing ones (Slack, Postmark, generic-HMAC). The outbound capability is a thin wrapper over the existing HTTP fetcher plus a per-conversation channel lookup. The recipe is the longest tail item. Realistically one sprint of platform work, with WhatsApp template approval being a real-world dependency partners drive in parallel.

### 25. Email-out conversation thread — ⚪ Not started

**Why it matters.** Postmark inbound (item 14) already lets the platform receive email; the symmetric piece — replying _into the same thread_ — is what makes an agent feel like a real correspondent rather than a no-reply autoresponder. Particularly valuable for complaint flows, legal-rights consultations, council intake, and customer-resolution use cases where the email thread itself is the audit trail of decision: a partner's compliance lead wants to read the conversation back later, and "first email, then a different thread of replies, then a third standalone summary" is unusable for that purpose. With proper threading, a single subject line carries the whole conversation; a future cited reply lands in the right inbox folder; a forwarded thread to a colleague shows the agent as one participant among others rather than as a system stub.

**What we'd ship.** A new column on `AiConversation` — `emailThreadAnchor Json?` carrying the original inbound `Message-ID` plus the running `References` chain, written on first inbound email and read on every subsequent outbound. The Postmark adapter (and any future email-in adapter) extracts `Message-ID`, `In-Reply-To`, and `References` from the inbound payload into the normalised trigger shape so the workflow input contract carries them. A new `reply_in_email_thread` capability (built on the generic HTTP fetcher and the existing transactional-email recipe) takes `{ conversationId, body, subject? }`, looks up the anchor, posts via Postmark / Mailgun / SES with `In-Reply-To` set to the prior outbound message ID and `References` set to the full chain, and writes the new outbound `Message-ID` back so the chain stays consistent. Subject-line policy is single-`Re:`-prefix on first reply, unchanged thereafter. A quoted-reply block is generated server-side rather than left to the LLM. The transactional-email recipe gains a "threaded reply" variant.

**Benefits.** Closes the most common partner objection to email-in flows ("but then we can't actually have a conversation"). Reuses ~90% of the transactional-email recipe — adding the three threading headers is the entire new functionality. Threading itself is RFC 5322 standard, so every major mail client (Gmail, Outlook, Apple Mail, Thunderbird) renders the result as a normal conversation without per-client special-casing. The conversation's email thread becomes a shareable, forwardable, archivable artefact living in the partner's existing email system — no Sunrise login required to access the record.

**Risks.** Auto-reply loops are the perennial email hazard — an agent reply to a vacation auto-responder that itself auto-replies produces an infinite ping-pong. Mitigation: detect `Auto-Submitted: auto-replied` and `Precedence: bulk` headers on inbound and skip; cap per-conversation outbound rate to N replies per hour. Some inboxes (notably older on-premise Outlook) handle the `References` header poorly and split threads unexpectedly — documented as a known mail-client quirk rather than something to solve at the platform layer. Subject-line drift over many turns is also a real concern — partners need to know that "we changed the subject to be more specific on turn 5" is a feature their compliance lead might query.

**Difficulty: Low–Moderate.** The plumbing is small: one new column, one new capability built on the existing HTTP fetcher, one new recipe variant. The risk is concentrated in the edge cases (auto-reply loops, multipart attachments on the reply path, quoted-block formatting that mail clients do not double-quote) — careful work rather than complex work. Half a sprint.

### 26. In-chat structured affordances — cards, forms, calendar pickers, inline charts — ⚪ Not started

**Why it matters.** Many of the business-applications worked examples currently degrade to clunky free-text where a small structured affordance would massively raise both UX quality and the agent's reliability. A booking flow for the independent tattoo studio asks "what date and time?" and parses out a typed sentence; a calendar picker eliminates both the parse step and the ambiguity. A council planning pre-screen asks for an address and gets "the one on the corner near the Tesco" back; an address autocomplete eliminates the entire class of follow-up disambiguation turns. A council-spend query produces a paragraph of numbers; an inline chart turns that into a glance-able answer with the citation still attached. The structural win is that **the LLM cannot fumble a date that came from a calendar widget** — moving the structured pieces of the conversation out of free text removes whole categories of model error before they happen.

**What we'd ship.** A new SSE event variant (`ui_card`) carrying a discriminated-union payload — `{ type, props, cardId }` — emitted by a new `present_ui_card` system capability. The starter set is four card types: `date_picker`, `single_choice`, `multi_choice`, and `chart` (Recharts bar / line for `[{ label, value }]` data). React components live under `components/admin/orchestration/chat/cards/` and render inside `MessageWithCitations` (or a sibling slot) when message metadata carries a card payload. The embed widget mirrors them in vanilla JS via DOM construction (same pattern as the approval card in item 11) — bar / line charts ship as small in-house SVG so the widget stays React-free. User submissions on each card route back through the conversation as a follow-up user message with structured metadata, so the LLM sees the submitted value on its next turn as tool input rather than as natural language. One recipe walks through a full calendar booking flow end-to-end: agent asks → date picker → time picker → confirmation card → workflow approval (item 11).

**Benefits.** Removes whole categories of LLM ambiguity (date parsing, address disambiguation, "did the user mean A or B"). Raises the perceived polish of every conversation that uses one — the contrast between "type your date in any format" and a real date picker is the kind of detail that closes partner pilots. Composes with the approval card (item 11), workflow versioning (item 12), and the citation envelope already shipped — a workflow's input form is itself a card sequence, and an inline chart with citations closes the trust loop on a data query the way a paragraph of numbers cannot.

**Risks.** Card sprawl is the biggest risk — every additional card type doubles the surface to test, the embed-widget mirror to maintain, and the documentation footprint. Mitigation: ship the four starter types, document a clear extension path via the capability registry (a custom card type is a capability that emits a `ui_card` event), and resist adding more without a partner-driven use case. Charts in the embed widget are a real complication — Recharts is React; the embed is vanilla Shadow DOM. Initial scope is a small in-house SVG renderer for bar and line charts only; if a partner asks for richer charts, the embed widget can graduate to React, a bigger architectural step that earns its keep at that point, not before. Mobile rendering of date / time pickers uses native `<input type="date">` and `<input type="time">` — adequate everywhere but not beautiful; revisit only if partners complain.

**Difficulty: Moderate–High.** The SSE event variant + React components + capability is one sprint of focused work. The embed-widget mirrors (especially the SVG chart renderer) are the schedule risk — every card type doubles to two implementations. Realistically one and a half to two sprints if all four card types ship together, or one sprint per pair if scoped down.

### 27. Conversation export / share (PDF or signed link) — ⚪ Not started

**Why it matters.** For legal, compliance, health, financial, and customer-resolution use cases, the conversation itself is the artefact — a record of advice given, a complaint thread, a pre-application chat. Today partners either screenshot, copy-paste into a Google Doc, or build their own export — the platform leaves this on the table. The feature is rarely the wedge that closes a pilot, but it is consistently the first thing partners ask for once a pilot is live, and shipping it as a polished default avoids the per-partner "can you build us an export?" custom work that doesn't generalise.

**What we'd ship.** A new `export_conversation` system capability with args `{ conversationId, format: 'pdf' | 'markdown' | 'html', includeCitations: boolean, includeMetadata: boolean }`. An HTML template at `lib/orchestration/exports/conversation-template.ts` renders the conversation with citation footnotes preserved, a sources list at the foot, and conversation metadata (agent name, started-at, completed-at, total turns) in a header block. PDF generation pipes the HTML through the existing Gotenberg recipe (the multipart path from item 17 makes this clean); Markdown is direct render for the lighter case. The capability writes the result through `upload_to_storage` (item 16) and returns a signed URL with configurable TTL (defaults to 7 days, S3-only; Vercel Blob / local fall back to permanent public URLs with a documented caveat). A "Download conversation" button appears in the admin chat UI header and in the embed widget header (per-agent toggle in `widgetConfig` so partners can opt in / out). Optional per-message redaction reuses the output-guard PII detector to mask sensitive cells before render.

**Benefits.** Closes a known recurring partner ask without per-pilot custom work. Pairs naturally with the items that already shipped — `upload_to_storage` for persistence, Gotenberg for rendering, signed URLs for sharing, citation envelope for grounded references in the export. Makes conversations portable across team boundaries: a partner's compliance lead can be sent a PDF rather than given a Sunrise admin login. The Markdown variant doubles as the export format for downstream tools (Slack, Notion, internal wikis).

**Risks.** Authorisation on the share link is the main risk — the signed URL alone is a capability, anyone with it sees the conversation. Acceptable for most cases (the partner shares intentionally); sensitive cases need a one-time-token-with-login model that is a bigger feature, deferred until a partner asks. Truncation of long conversations: default to "full export" but flag conversations over N turns to prevent an accidental unbounded PDF render — soft cap at 200 turns with a "download as multi-part" affordance if exceeded. The export captures the conversation at a moment in time — versioning the export itself (re-export a year later, are the citations still pointing at live sources?) is out of scope for v1 and documented as a known limitation.

**Difficulty: Low–Moderate.** Most of the moving parts already exist: persistence (`upload_to_storage`), PDF generation (Gotenberg + multipart), signed URLs, citation envelope. The new work is the HTML template, the capability wrapper, the per-agent toggle in `widgetConfig`, and the download buttons on two surfaces. Half a sprint to a sprint, depending on how many format variants ship together.

### 28. Live agent handover ("talk to a human") — ⚪ Not started

**Why it matters.** Partners in regulated or high-stakes domains (housing, financial, health, complaints) frequently require a human escape hatch before they will deploy. Without one, the agent's failure mode is "user gets stuck and abandons"; with one, the failure mode is "user gets routed to a human who can resolve it" — the operational continuity story partners actually want. The legal advisor, mortgage broker, tenant rights, and council planning worked examples in `business-applications.md` all require this before production deployment, and the absence of it is among the most common pilot-blockers we hear in commercial conversations. Handover is also the natural pair to the consumer-side approval flow (item 11) — both are the platform admitting that "not every decision should be made by the agent alone," but where item 11 pauses for approval on a specific action, handover transfers the entire conversation to a person.

**What we'd ship.** A new `request_human_handover` system capability with args `{ reason, urgency, summary }`. The capability persists a new `AiHandoverRequest` row (status: `pending` / `accepted` / `declined` / `expired`), fires a `conversation.handover_requested` event hook, and sends pre-signed accept / decline URLs to per-agent-configured duty channels (Slack DMs, email, SMS via item 24). A new admin surface at `/admin/orchestration/handovers` lists pending handovers with sidebar badge count (mirrors the approval queue UI). When an admin accepts, the streaming handler enters "takeover mode" — the agent's LLM invocation is skipped, admin-typed messages POST to a new endpoint that emits them into the user's existing SSE stream as assistant messages with a `humanAgent: true` metadata flag, and a banner appears at the top of the user's chat ("You're now talking with a person — N from the team"). The end user's reply routes to the admin chat surface rather than back to the LLM. The admin releases the session via an explicit "Hand back to agent" button, which clears takeover mode and resumes normal LLM responses. Per-agent config exposes `handoverConfig.enabled`, `handoverConfig.dutyChannels[]`, and `handoverConfig.automaticTriggers` — sentiment thresholds, repeated capability failures, or user phrases like "speak to a human" that trigger the capability without explicit LLM invocation. Every admin message in takeover mode writes an audit-log row with the actor's user id; the trace viewer renders these distinctly from LLM responses.

**Benefits.** Closes the most common partner pilot-blocker in regulated domains. Reuses the hook + outbound-webhook plumbing already in place for routing notifications. Composes cleanly with items 24 (SMS / WhatsApp as the duty channel) and 25 (email handover via a threaded reply). Creates a clean audit trail of human interventions — a metric of "% conversations escalated to human" becomes a partner-visible quality signal alongside the existing faithfulness / groundedness / relevance metrics. Pairs with item 22 (feedback-loop health) — a rising handover rate is itself a feedback-loop signal that the agent's confidence model may be degrading.

**Risks.** Asynchronous handover is the messy case — if no duty admin is available within N seconds, the user is stuck waiting on a person who is not coming. Mitigation: configurable per-agent timeout with a fallback message ("No one is available right now — we'll get back to you within X hours") and an automatic transition to an email / SMS follow-up flow that pairs with item 25. Queue priority (FIFO vs urgency-weighted vs round-robin) needs an admin knob — default FIFO, with urgency weighting as a follow-on. The takeover-mode injection point in the streaming handler is the trickiest piece of plumbing — SSE is one-way, so admin-typed messages POST to a new endpoint that emits into the user's existing stream; this works but requires careful state management to avoid race conditions (an in-flight LLM call when the admin accepts). Trust-and-safety: an admin in takeover mode is sending messages to an end user as the platform — same threat model as a customer-support tool, and audit-logged accordingly.

**Difficulty: Moderate.** New capability + new admin surface + streaming-handler takeover-mode plumbing + new event hook + per-agent config + audit integration. Most of the pieces are extensions of existing patterns (the approval queue's admin UI for the handover list, the hook dispatcher for duty notification, `widgetConfig` for per-agent toggles). The streaming-handler injection is the genuinely new code and is the schedule risk. One and a half sprints.

### Tier summary

The five items split naturally into two pairs and a closer.

- **Items 24 and 25 (WhatsApp / SMS + email threading)** unlock user populations the embed widget cannot reach. Both extend the existing inbound-triggers framework rather than introducing new architecture, so the per-item effort is bounded.
- **Items 26 and 27 (structured cards + conversation export)** raise the conversational surface — what a conversation looks like and what it produces as an artefact. Both compose cleanly with items already shipped (approval card, citation envelope, `upload_to_storage`, Gotenberg recipe).
- **Item 28 (live handover)** is the operational trust loop — the explicit admission that not every conversation should end inside the agent. It is the most common pilot-blocker in regulated verticals and reuses the most existing primitives (hooks, approval queue UI patterns, `widgetConfig`).

Sequenced for shortest path to commercial impact: **24 → 28 → 25 → 27 → 26**, with item 24 first because it unlocks the largest new audience, item 28 second because it removes the most common pilot-blocker, items 25 and 27 picked up in the order partner conversations demand, and item 26 last because it is the most architecturally ambitious and the natural "save for a slot with a clear partner ask" item.

---

## Tier 7 — Proposed: lifecycle, integration, and operational symmetry

A third category of proposed work covering symmetric gaps in the platform's existing primitives and lifecycle. Where Tier 5 deepens **what an agent is** and Tier 6 widens **where the agent reaches**, Tier 7 closes the **missing halves of primitives that have only shipped in one direction**. Two observations frame the shape:

- **Several primitives shipped with only one half built.** Voice input arrived (item 19) without voice output; the MCP server arrived without an MCP client; scheduled retention arrived without on-demand erasure; on-upload ingestion (item 5) arrived without runtime freshness scanning; per-agent cost attribution arrived without per-end-user attribution. None of these absences is a principled choice — they are the natural shape of "ship the most pressing half first, defer the second half." Tier 7 is the second-half cohort.
- **Workflow versioning and capability authoring each have a single residual failure mode.** Workflow versioning (item 12) shipped publish/draft/rollback as atomic snapshots but no gradual transition (canary) and no stubbed dry-run execution (today's dry-run is validation-only). Capability authoring shipped hand-coded `BaseCapability` subclasses but no codegen path from a partner's OpenAPI spec. Both gaps slow partner onboarding without being load-bearing themselves.

Items 29 and 30 are commercial-priority — they unblock procurement objections and multiply integration reach. Items 31 through 33 are operational-symmetry — they close gaps in primitives partners already use. Items 34 through 36 are velocity-multipliers — they reduce the cost of changing what's already built.

| #   | Improvement                                       | Value         | Effort        | Status         |
| --- | ------------------------------------------------- | ------------- | ------------- | -------------- |
| 29  | GDPR end-user erasure (DSAR / Right-to-Erasure)   | Very high     | Moderate      | ⚪ Not started |
| 30  | MCP outbound client                               | High          | Moderate      | ⚪ Not started |
| 31  | Knowledge-base freshness scanner                  | High          | Moderate      | ⚪ Not started |
| 32  | Voice output (TTS) — symmetric to item 19         | Moderate      | Low–Moderate  | ⚪ Not started |
| 33  | Per-end-user cost attribution                     | Moderate–High | Low–Moderate  | ⚪ Not started |
| 34  | Workflow agentic dry-run (stubbed-execution mode) | Moderate–High | Moderate      | ⚪ Not started |
| 35  | Shadow / canary version routing                   | Moderate      | Moderate–High | ⚪ Not started |
| 36  | OpenAPI-driven capability generator               | Moderate      | Moderate      | ⚪ Not started |

### 29. GDPR end-user erasure (DSAR / Right-to-Erasure) — ⚪ Not started

**Why it matters.** Every regulated-vertical worked example in `business-applications.md` — legal advice, mortgage broking, tenant rights, council planning, health protocols, financial planning, customer-resolution — is sold into procurement teams that treat GDPR Article 17 Right-to-Erasure and Article 15 Right-of-Access as non-negotiable. Today the platform has _scheduled_ retention plumbing (`AiAgent.retentionDays`, `costLogRetentionDays`, `webhookRetentionDays`, `auditLogRetentionDays`) but no _on-demand_ operation that, given an end-user identifier, finds and erases their data across the eight-plus models that store it. `functional-robustness-test-plan.md` documents this as an unimplemented test scenario. The recurring partner-procurement objection makes this commercial-risk rather than nice-to-have — it is the kind of feature whose absence terminates a sales conversation regardless of how good the platform's quality posture is.

This is the on-demand half of a primitive whose scheduled half already exists.

**What we'd ship.** A new `lib/orchestration/data-subject/` module owning the lookup contract: identifier → list of touchpoints. New admin routes `POST /api/v1/admin/orchestration/data-subject/export` and `/erase` taking `{ identifier: { type: 'email' | 'phone' | 'channelAddress' | 'userId', value } }`. The lookup walks `AiConversation` rows via the `(channel, fromAddress)` key item 14 already populates, or via `User.id` cascade for registered users, then traverses every owning model: `AiMessage`, `AiCostLog`, `AiEvaluationLog`, `AiUserMemory`, `AiWorkflowExecution.inputData`, `AiInboundTriggerDelivery.payload`, plus any future model that captures user content (a per-model audit during implementation enumerates the full surface). Export returns a signed-URL JSON bundle (chains `upload_to_storage` from item 16). Erasure runs the same walk inside a single `$transaction`, replaces user-content fields with redaction markers where rows must survive for aggregate integrity (`AiCostLog.metadata` retains tokens but nulls user-identifying fields; `AiAdminAuditLog` rows are preserved because the audit trail of erasure must itself be auditable, but with content redacted), and writes a `data_subject.erasure` audit row recording the actor, identifier hash, and which models were touched. A new `AiDataSubjectRequest` table records every request with `requestId`, `requestType`, `identifierHash` (SHA-256 with a system-secret salt so the audit table does not itself become a re-identification surface), `requestedAt`, `completedAt`, `actorUserId`, and `affectedRowCounts` for the compliance audit trail partners will be asked for during their own audits.

**UI shape.** A new admin page `/admin/orchestration/compliance/data-subject` with two tabs — "Pending Requests" and "History". Pending tab has a form with identifier-type dropdown + value input + action dropdown (Export / Erase) + preview button. Preview returns the lookup-walk result counts (e.g. "Would erase: 3 conversations, 47 messages, 12 cost logs, 1 user memory entry") without committing; admin clicks Confirm to execute. History tab is a paged list of past requests with status, actor, and a "Re-run export" button for export requests (erasure is irreversible). FieldHelp on the identifier-type dropdown explains the inbound-trigger channel-key model for non-registered users.

**Benefits.**

- **Unblocks regulated-vertical pilots.** Procurement teams in legal, financial, health, council, and customer-resolution domains list DSAR as a binary gate. Today partners write the SQL by hand or refuse the pilot.
- **Compliance audit trail by design.** The `AiDataSubjectRequest` table is the artefact partners hand to their own auditors. Without it they hand over screenshots.
- **Composes with item 25 (email-out threading).** DSAR confirmation can thread back into the original inbound email conversation, closing the loop for the requester.
- **Reuses existing infrastructure.** Retention plumbing, audit log, `upload_to_storage`, channel-key model from item 14 — all already there.
- **Forces honest reckoning with retention defaults.** Building the on-demand walk surfaces every model that captures user content; that audit drives better defaults for retention scheduling.

**Risks.**

- **Aggregate-integrity vs erasure tension.** Some rows (cost logs, audit logs) must persist for billing or compliance reasons. Mitigation: redaction-not-deletion for those models, with explicit field-level rules documented per model. The DSAR request bundle includes the redaction map so the requester sees what was kept and why.
- **Identifier resolution ambiguity.** A single email may appear across multiple `(channel, fromAddress)` rows from different inbound channels. Mitigation: the lookup walk is union-of-matches by default; the preview shows what would be touched so the admin can scope down with additional filters before confirming.
- **Async dispatched work.** Inbound triggers and outbound webhooks both fire-and-forget — erasure cannot reach in-flight or yet-to-fire work. Mitigation: a 24-hour cooling period during which the erasure record is "pending dispatch", after which any newly-arriving data for that identifier is rejected at the channel-key match in the inbound handler.
- **Audit-of-audit.** Who erases the erasure record? Mitigation: never. Erasure records carry only `identifierHash`, not the identifier itself, so the audit trail does not itself become a re-identification surface.

**Difficulty: Moderate.** New module + two admin routes + one new table + one new admin page + redaction rules per model. The architectural work is bounded; the schedule risk is auditing every Prisma model for user-content fields. One sprint.

### 30. MCP outbound client — ⚪ Not started

**Why it matters.** Sunrise is an MCP _server_ today — IDE extensions, Claude Desktop, and third-party agents can call into Sunrise via `/api/v1/mcp`. The symmetric piece is missing: Sunrise agents cannot call _out_ to other MCP servers. The MCP ecosystem now publishes hundreds of first-party servers (filesystem, database, search engines, GitHub, Linear, Notion, Stripe, Sentry, Cloudflare, vendor SaaS); each one Sunrise can speak to is an integration partners get without per-vendor capability code. The framing matches Sunrise's existing "most-interoperable starter template" posture and gives partners a real choice for each new integration: HMAC-signed REST recipe (item 3, today) or MCP outbound (new) — both first-class.

This is distinct from A2A protocol support (Tier 4 de-prioritised): A2A is inter-system _agent coordination_; MCP outbound is single-system tool-calling against external servers. The arch-decisions doc treats MCP-client as a scope decision ("Sunrise is MCP server; client consumption not in scope"), not a principled rejection. This proposal makes it scope.

**What we'd ship.** A new `lib/orchestration/mcp-client/` module mirroring the existing `lib/orchestration/mcp/` server shape. A new `call_mcp_tool` system capability with args `{ serverSlug, toolName, arguments }`. A new `AiMcpServer` table linking `(slug, serverUrl, authMode, authSecret, allowedAgentIds, isEnabled)` so admins register external servers once and bind them to specific agents via the existing capability-binding flow. Per-agent `customConfig.allowedMcpServers` allowlist (URL-slug matched, same posture as the SSRF protection on `external_call`) controls which servers each agent can hit. Connection pooling per `(serverSlug, authSecret)` with the same 1-hour idle TTL as the server's session manager. Auth modes mirror the HTTP fetcher: `none` / `bearer` / `api-key` / `query-param`. Tool-discovery is `list_tools` on first connection; results cached for the per-server-config TTL (default 1 hour) and refreshable by clicking "Refresh tools" on the server config page.

**UI shape.** A new admin page `/admin/orchestration/mcp/servers` (sibling to the existing `/admin/orchestration/mcp` server-side config). Card grid: each server card shows status dot, last successful discovery, tool count, agents using. Click into a card → server-form with URL, auth-mode picker, allowlist editor, and a "Discover tools" button that lists the live tool catalogue. The Agent form's Capabilities tab gains a "MCP servers" sub-section (collapsed by default) listing this agent's allowed servers. The trace viewer's tool-call sub-panel renders MCP outbound calls distinctly from REST `external_call` so admins can identify them at a glance.

**Benefits.**

- **Multiplies the integration surface for free.** Every MCP server in the ecosystem becomes a candidate integration without per-vendor capability code.
- **Symmetric architecture.** The platform is both an MCP server and an MCP client — closes the obvious gap.
- **Pairs with item 3 (HTTP recipes) for choice.** Partners pick the integration mode best suited to each vendor.
- **Pairs with item 36 (OpenAPI generator)** as the alternative integration mode for vendors who ship OpenAPI but not MCP, and vice versa.
- **Reuses item 14's SSRF allowlist posture and auth-mode plumbing.** No new security surface beyond the per-server allowlist.

**Risks.**

- **External tool quality varies.** A misbehaving MCP server can return malformed tool schemas or hang on `tools/call`. Mitigation: per-call timeout (default 30s), schema validation against the discovered shape, circuit-breaker fall-through to a step error rather than a hung agent.
- **Tool-name collisions.** Two MCP servers may expose tools named `search` or `list`. Mitigation: capability resolver namespaces external tools as `mcp:{serverSlug}:{toolName}` so the LLM sees disambiguated names.
- **Auth-secret hygiene.** External tokens stored in `AiMcpServer.authSecret` are sensitive. Mitigation: same plaintext-in-DB posture as `AiWorkflowTrigger.signingSecret` (acknowledged operational gap in `architectural-decisions.md`), with the same future-hardening path to envelope encryption.
- **Discovery drift.** A server may add or remove tools between discoveries. Mitigation: agents bind to tool-names, not tool-shapes; missing tools surface as a step error with "tool no longer offered" rather than silent skip.

**Difficulty: Moderate.** New module + new capability + new table + new admin page + protocol-handler client implementation. Mirrors the existing server-side MCP work; same auth and allowlist primitives. One sprint.

### 31. Knowledge-base freshness scanner — ⚪ Not started

**Why it matters.** Item 5 (ingestion robustness) closed the on-upload side; the runtime side is unobserved. Source URLs go 404 (council pages restructure, legal sites move, vendor docs version themselves), source PDFs get revised upstream (planning policy updates, lender criteria refreshes), and citations end up pointing at content that no longer says what the agent claims it does. For the citation-grounded advisor templates that shipped in item 4 (`tpl-cited-knowledge-advisor`) and the regulated-domain partner pilots that depend on them, this is the silent quality-erosion story item 22 (feedback-loop health) talks about, but for the corpus rather than the loop.

The platform today has no runtime freshness signal at all. Citations look fresh because the _citation envelope_ is fresh; the _content_ they cite may be months out of date. Closing this gap is the runtime complement to item 5.

**What we'd ship.** A scheduled `knowledge-freshness-tick` reusing the maintenance-tick plumbing from item 8's async execution model. The tick walks `AiKnowledgeDocument` rows with `sourceUrl IS NOT NULL`, re-fetches via the existing `url-fetcher`, compares SHA-256 against `metadata.fetchedHash`, and emits one of four states: `unchanged`, `changed-minor` (whitespace / metadata only), `changed-content` (text body diff), `gone` (404 / 410). State transitions write to a new `AiKnowledgeStaleness` table linking `(documentId, detectedAt, previousState, newState, diffSize, resolvedAt, resolverUserId)` and emit a `knowledge.source.stale` event hook so partner ops can route to Slack via the existing webhook dispatcher (item 14).

A new admin page `/admin/orchestration/knowledge/stale` queues changed and gone documents for triage with three actions per row: re-ingest (rebuilds chunks and embeddings from the new source), mark-resolved (the changes are not material), mark-deprecated (the document should no longer be cited; agents see citations to it suffixed with a deprecation marker). Per-document `freshnessConfig.checkIntervalDays` (default 7) keeps the load bounded; documents with `sourceUrl IS NULL` (uploaded PDFs without a source URL) are excluded from the tick.

**UI shape.** Page header card shows three counts — Changed, Gone, Unresolved — with a sparkline of the last 30 days. Table below: document name, source URL, last-checked, state (chip), diff size, age-of-staleness, action buttons. Clicking a "changed-content" row opens a side panel with a text-diff view of the parsed content before/after; clicking a "gone" row opens a side panel showing the last-known fetch result. The existing Knowledge tab on the Agent form gains a "stale citations" badge if any of the agent's accessible documents are in `changed-content` or `gone` state.

**Benefits.**

- **Closes the silent quality-erosion gap** between "we shipped a cited answer" and "the citation is still true."
- **Pairs with item 2 (citations).** A citation pointing at deprecated content gets a `[N: source updated YYYY-MM-DD]` chip in the agent's response, surfacing the staleness to end-users.
- **Pairs with item 22 (feedback-loop health).** Same dashboard surface, complementary signal — feedback-loop health watches the _loop_, freshness watches the _corpus_.
- **Reuses existing infrastructure.** Maintenance-tick, URL fetcher, event-hook dispatcher, agent-knowledge access model.
- **Bounded load.** Per-document interval keeps the tick cheap; admin can scope frequency per-document for high-volatility sources.

**Risks.**

- **False positives on volatile pages.** A page with rotating ads or a "last viewed: X" timestamp triggers `changed-content` on every check. Mitigation: a content-extraction step strips known noise (script tags, common rotating elements) before hashing; admins can mark specific change patterns as "noise" per document.
- **Aggressive re-fetch posture.** Some sources rate-limit or block frequent fetches. Mitigation: per-document interval with a sensible default; respect `Retry-After` and back off; log persistent failures distinctly from `gone`.
- **Re-ingestion cost.** Re-ingesting a 200-page PDF every week is wasteful when only the version footer changed. Mitigation: `changed-minor` state does _not_ auto-trigger re-ingestion; only `changed-content` does, and the admin decides when to re-ingest from the queue.
- **Citation-deprecation UX.** A response that cites a deprecated source needs to surface the deprecation without alarming the end-user unnecessarily. Mitigation: chip styling matches the existing citation chip, with hover text "this source was updated on YYYY-MM-DD; the cited content may have changed" — informational, not alarmist.

**Difficulty: Moderate.** New scheduled tick + new table + new admin page + hook event + minor chip rendering change in the citation envelope. Reuses URL fetcher, maintenance-tick, event-hook plumbing. One sprint.

### 32. Voice output (TTS) — symmetric to item 19 — ⚪ Not started

**Why it matters.** Item 19 shipped voice _in_ via Whisper transcription. The symmetric piece — text _out_ as audio — closes the accessibility and mobile-UX argument that drove item 19 in the first place. End-user populations that rely on screen-readers, partners building kiosk / automotive / smart-speaker pilots, and the same WhatsApp-voice-note audience that item 24 targets all benefit. The infrastructure shape is already proven by item 19: provider-capability gating (`'audio'` filter on `AiProviderModel`), per-agent `enableVoiceInput` toggle plus org-wide setting, fire-and-forget cost logging with per-row `metadata.durationMs`, `Permissions-Policy: microphone=(self)` headers — every piece extends cleanly to a `speaker` Permissions-Policy and a `synthesize` capability on the provider abstraction.

The asymmetry of "we listen but we don't talk back" is conspicuous after item 19 shipped; partners ask about it within the first demo session.

**What we'd ship.** A new optional method `LlmProvider.synthesize?(text, options)` on the provider interface; one first-party implementation against OpenAI-compatible `audio.speech.create` (works for OpenAI proper and any compatible host such as Groq's TTS-capable hosts). New `CostOperation = 'synthesis'` rows in the cost-tracking pipeline with per-character or per-minute pricing (provider-dependent). New per-agent `AiAgent.enableVoiceOutput` and org-wide `AiOrchestrationSettings.voiceOutputGloballyEnabled` toggles mirroring item 19's gating. An SSE event variant `audio_url` that the streaming handler emits after a turn completes when `enableVoiceOutput` is on; the URL is a signed link to an `upload_to_storage`-persisted MP3 (item 16). Admin agent-test-chat and embed widget both render a "play" button per assistant message; widget-config endpoint advertises the `voiceOutput` capability so the loader does not surface a control guaranteed to error.

**UI shape.** Per-agent toggle on the Agent form's "Multimodal" sub-section (alongside the existing voice-input and vision toggles). FieldHelp explains cost-per-character and the provider-capability gating. End-user surface: a small play-button next to each assistant message; first click streams audio; subsequent clicks replay from cache. The embed widget mirrors via a vanilla `<audio>` element. Org-wide settings page gains a `voiceOutputGloballyEnabled` toggle and a default provider/voice picker (OpenAI ships six voices; default `alloy`).

**Benefits.**

- **Symmetric to item 19.** Voice-in shipped; voice-out is the obvious complement and is asked for in every demo.
- **Accessibility win.** Screen-reader users get a parallel audio surface without browser-TTS quality issues.
- **Pairs with item 24 (WhatsApp / SMS) for voice-note replies.** MMS-capable Twilio channels can carry the synthesized audio directly back to the user's phone.
- **Low schedule cost.** Item 19's plumbing extends cleanly; the new code is the provider method plus the SSE event variant plus two render surfaces.

**Risks.**

- **Voice selection sprawl.** Six OpenAI voices is manageable; eleven providers × dozens of voices each becomes a configuration nightmare. Mitigation: org-wide default voice; per-agent override only when specifically configured.
- **Cost surprise.** Long replies × per-character pricing add up. Mitigation: cost-preview in the agent test chat ("this 800-character reply would cost $0.012 to synthesize"); per-agent monthly cap on synthesis cost.
- **Audio file lifecycle.** Synthesized audio accumulates in `upload_to_storage`. Mitigation: tied to conversation lifecycle — synthesized audio gets the same retention as the conversation that produced it.
- **Streaming vs file UX.** Voice output is naturally streaming, but the simpler MVP is "synthesize-then-play." Mitigation: ship file-based v1; streaming TTS is a follow-on if partners ask.

**Difficulty: Low–Moderate.** Provider method + SSE event + two render surfaces + cost integration + per-agent toggle. Half-to-one sprint.

### 33. Per-end-user cost attribution — ⚪ Not started

**Why it matters.** Cost rollups today aggregate by `agentId`, `conversationId`, and `workflowExecutionId`. For consumer-facing chatbots (the embed-widget audience from item 7), B2B SaaS deployments where the operator invoices per-seat, and regulated-vertical pilots where partners need per-user fair-use enforcement, the missing column is `endUserId` — the end-visitor that drove the spend. Today partners back into per-user spend by joining `AiCostLog` to `AiConversation` to whatever identifies the user — a query that works for them once but does not show up as a dashboard card or feed budget enforcement.

Pairs with item 29 (GDPR erasure) — both walk the same end-user identifier graph — and with item 28 (live handover), where a rising per-user cost is itself a handover-trigger signal.

**What we'd ship.** Additive migration: `AiCostLog.endUserId String?` plus `AiCostLog.endUserChannel String?` (the channel-specific identifier discriminator — `'registered'` / `'embed'` / `'twilio'` / `'postmark'` / etc.). `AiConversation` already carries the channel-key from item 14; the streaming handler threads it into `logCost()`. Admin route `/api/v1/admin/orchestration/analytics/cost-by-end-user` returns paged rollups keyed on `(endUserChannel, endUserId)` with the standard `from` / `to` / `agentId` filters. Per-end-user budget caps via `AiOrchestrationSettings.endUserMonthlyBudgetUsdDefault` and per-agent override reuse the existing budget-enforcement loop, with one additional check inside the tool loop. Privacy: end-user identifiers are subject to the item 29 erasure walk — the lookup module added in item 29 already handles the channel-key form.

**UI shape.** New "Cost by end-user" card on the existing Costs dashboard. Sortable table: end-user (with masked identifier — `j****@example.com`), conversations, messages, total cost, last-active. Filter chips: channel, agent, date range. Drill-in shows per-conversation cost breakdown with links to each conversation in the trace viewer. A "set budget cap" action per row creates a per-end-user override entry.

**Benefits.**

- **Closes a known partner question that today requires ad-hoc SQL.**
- **Pairs with item 29 (GDPR erasure)** — the identifier-walk machinery is shared; building 33 makes 29 cheaper.
- **Pairs with item 22 (feedback-loop health)** — per-end-user cost trend is a new dashboard card, and a rising trend is a quality signal as well as a cost signal.
- **Enables consumer-grade fair-use enforcement** without per-partner custom code.
- **Conditional value.** Earns its keep when partner pilots become consumer-shaped (items 24 / 25 / 26 unlocking those audiences); less valuable for purely-internal deployments.

**Risks.**

- **PII vs analytics tension.** End-user identifiers (email, phone) are PII. Mitigation: store hashed identifiers in `AiCostLog` (the raw value lives on `AiConversation`); analytics display masks the identifier; erasure (item 29) zeroes both.
- **Cardinality.** A widely-deployed agent could see millions of end-user rows. Mitigation: partition the rollup table by month if cardinality bites; reuse the maintenance-tick pruning logic.
- **Budget enforcement granularity.** Hitting an end-user cap mid-conversation is jarring. Mitigation: enforcement is at _conversation start_ by default (subsequent messages within the same conversation are allowed to complete); per-agent config can opt into hard mid-conversation enforcement for strict use cases.

**Difficulty: Low–Moderate.** Additive migration + one new route + one new dashboard card + budget-enforcement integration + erasure-walk extension. Half-to-one sprint.

### 34. Workflow agentic dry-run (stubbed-execution mode) — ⚪ Not started

**Why it matters.** The existing dry-run endpoint is _validation-only_ — DAG checks, semantic validation, template-variable extraction. It does not walk the DAG with stubbed step outputs. For workflow authors iterating on long-running cron- or inbound-triggered workflows (item 14) where a real run costs money and writes to side-effects via `external_call`, `send_notification`, `upload_to_storage`, the missing piece is an execution mode that does a real DAG walk with side-effects stubbed and trace captured. Closes the gap between "I authored a workflow" and "I am confident it will behave on first real fire."

The Big-Bang failure mode of "we set the workflow live, it called the wrong API" is what this prevents. Composes with workflow versioning (item 12) — dry-run a _draft_ against test inputs before clicking Publish.

**What we'd ship.** Extend the existing dry-run route to accept `{ mode: 'validate' | 'execute', inputData?, stubOverrides? }`. In `execute` mode, the engine walks the DAG with the supplied `inputData` and runs every step through stubbed executors that return type-shape-valid mock outputs: `external_call` returns `{ status: 200, body: <stub-from-output-schema> }`; `send_notification` records the would-have-been payload but does not dispatch; `tool_call` returns a stubbed schema-valid result; `human_approval` immediately resolves with `approved: true`. The `llm_call` step has two stub modes — "echo" (returns a deterministic shape-valid placeholder) and "live" (actually calls the LLM provider; the LLM is rarely the side-effect risk, just the cost risk). `stubOverrides` lets the author seed specific step outputs for branch-coverage testing.

The full execution trace is captured in the same `executionTraceEntry` shape as a real run, surfaced through the same trace viewer (item 10) with a "Dry Run" banner and per-step "Stubbed" chips. A `discardOnComplete` flag prevents stubbed runs from polluting the executions list (default true; admins can opt to retain for diff-after-edit comparison).

**UI shape.** The workflow builder's existing Test tab gains a mode toggle: "Validate only" (today) / "Execute stubbed" (new). Execute-stubbed mode shows a stub-override panel where authors can override specific step outputs before running. Results render in the existing trace viewer with the Dry Run banner; a "Compare to last real run" button surfaces a diff against the most recent production execution of the same workflow if one exists.

**Benefits.**

- **Trust before publish.** Authors gain a real DAG walk without real side-effects.
- **Pairs with item 12 (workflow versioning).** Dry-run a draft, see the trace, click Publish.
- **Reuses item 10's trace viewer.** Same surface, same shortcuts; no second mental model for inspection.
- **Standalone high-ROI for workflow-heavy partners.** Inbound-trigger and cron-driven pilots benefit disproportionately.

**Risks.**

- **Stub realism.** A stubbed `external_call` may pass a step that would have failed in production. Mitigation: stubs are schema-valid by construction; authors can override stub outputs to seed adverse cases; documentation frames dry-run as "shape and flow check" rather than "behaviour guarantee."
- **Trace pollution.** Dry-runs in the executions list confuse audit views. Mitigation: `discardOnComplete: true` by default; retained dry-runs render with the Dry Run banner everywhere they appear.
- **`llm_call` cost in live mode.** Authors who choose live mode get charged. Mitigation: cost preview before running; explicit "this will cost approximately $X" confirmation.

**Difficulty: Moderate.** Engine extension + stubbed-executor implementations + trace-viewer banner + workflow-builder mode toggle. One sprint.

### 35. Shadow / canary version routing — ⚪ Not started

**Why it matters.** Item 12 (workflow versioning) shipped publish/draft/rollback as atomic snapshots. The missing operational piece is the _gradual_ version transition: route N% of traffic to a new version, score divergence, expand or revert. Composes with the existing experiments traffic-splitting framework and item 34's stubbed dry-run to give partners a three-step safety profile — "stub-test, canary-test, full-publish" — that the publish-and-pray flow cannot match. Pairs symmetrically with item 23a (replay testing): replay scores divergence on historical traffic, canary scores divergence on live traffic.

This is the most architecturally-dependent item in Tier 7. It is _not_ a standalone wedge — its value is conditional on item 12 (already shipped) and item 23a (Tier 5) landing. Defer until at least one partner has run a model upgrade behind item 23a and asked for "the same but on live traffic."

**What we'd ship.** A new `AiWorkflowCanary` table linking `(workflowId, canaryVersionId, baselineVersionId, percentTraffic, startedAt, endedAt, status)`. For chat agents, a parallel `AiAgentCanary` table with the same shape against `AiAgentVersion`. The execution dispatcher consults the canary table when resolving the version to run; assignment is sticky per `(channel, fromAddress)` so end-users see a consistent version within a conversation. The trace viewer gains a "canary divergence" sub-panel that scores per-step output divergence using the same metrics as item 23a (replay): Levenshtein for strings, structural diff for JSON, cost delta, citation diff. A new admin page `/admin/orchestration/canaries` lists active canaries with promote / abort buttons; promotion is the same atomic operation as item 12's `publishDraft()`.

**UI shape.** A new "Canary" tab on the Workflow and Agent forms, alongside Versions. Start-canary flow: pick draft version, set traffic percentage (5% / 10% / 25% / 50% / 75%), set evaluation window (24h / 72h / 7d). Running state: live divergence card with metric deltas and a sample of diverging executions. Promote / abort buttons gated by minimum-sample-size threshold (default 50 executions).

**Benefits.**

- **Closes the publish-and-pray gap** that item 12 left open by design.
- **Pairs with item 23a (replay).** Two windows of evidence on the same model upgrade.
- **Reuses traffic-splitting plumbing** from the experiments framework.
- **Sticky per end-user.** No mid-conversation version swap; experience is consistent within a thread.

**Risks.**

- **Sticky-assignment skew.** Heavy users get permanently bucketed; light users may never see the canary. Mitigation: re-bucket on conversation start, not on first-ever interaction; document the trade.
- **Two-version cost.** Cost dashboards aggregate to agent/workflow level; canary-on means costs double for a slice of traffic. Mitigation: cost breakdown by version on the canary dashboard so the overhead is visible.
- **Diverging-result anxiety.** A canary that produces "different but arguably better" answers is the same dilemma as item 23a — the operator has to read the trade. Mitigation: the report is the same shape as item 23a's divergence report; same reading skill applies.
- **Engine-dispatcher complexity.** Version resolution now consults a canary table on every execution. Mitigation: the canary lookup is a single indexed row read; cache the active-canary set in-process with invalidation on the canary admin routes.

**Difficulty: Moderate–High.** Two new tables + dispatcher integration + canary admin page + trace-viewer divergence panel + promotion atomic operation. One-to-two sprints. Defer until item 23a has shipped and a partner has explicitly asked for the live-traffic complement.

### 36. OpenAPI-driven capability generator — ⚪ Not started

**Why it matters.** Item 3 (HTTP recipes) made integration cheap but still requires a human to author the recipe per vendor. For partners delivering an OpenAPI spec at procurement time — every SaaS vendor, every enterprise API gateway — the next step is "drop the spec, get a typed capability class." Three to five hours of partner-onboarding work collapses to minutes. Pairs with item 30 (MCP outbound client) as the alternative integration mode for vendors who ship OpenAPI but not MCP.

The `architectural-decisions.md` flag here is real ("Zod at every boundary; OpenAPI kept separate to avoid drift"). This proposal addresses the principle: the generator runs at _codegen time_, not at _runtime_. The generated Zod schema becomes the persistent runtime contract; the OpenAPI artefact is consumed once and discarded. Drift is concerned with runtime-OpenAPI-interpretation; codegen-time use is structurally different — the proposal text and the generated-capability file headers both state explicitly that OpenAPI is consumed once at codegen and the Zod schema is the source of truth and may be hand-edited after generation.

**What we'd ship.** A new `npm run generate:capability -- --spec=path/to/openapi.yaml --slug=acme-billing` command and an admin upload UI that runs the same generator server-side. The generator emits a `BaseCapability` subclass under `lib/orchestration/capabilities/generated/`, a Zod args schema derived from the OpenAPI operation's `parameters` and `requestBody`, an execution handler that maps args to an `httpFetch()` call against the operation path, and a Prisma seed row for `AiCapability`. The output is _plain source_ — readable, diffable, hand-editable post-generation, version-controlled like any other capability. Operations marked `x-internal: true` in the spec are skipped; operations without a `summary` or `operationId` trigger a generator warning rather than emitting a poorly-named capability.

The generator pulls from the existing `lib/orchestration/http/` fetcher for the actual call; auth modes are inferred from the OpenAPI `security` blocks where possible, with admin override at generation time. Generated capabilities require admin enablement in the standard capabilities-list page before agents can use them — generation does not auto-enable.

**UI shape.** A new admin route `/admin/orchestration/capabilities/import-openapi`. Upload field for the spec; once uploaded, the UI shows an operation list with checkboxes (default: all enabled), per-operation slug input (pre-filled from `operationId`), and an auth-mode picker. "Generate" runs the codegen and writes to disk (in dev) or stages a PR (in production deployments with git integration). Generated capabilities show a "From OpenAPI" chip in the capabilities list so admins know their provenance.

**Benefits.**

- **Collapses partner-onboarding cost** from hours to minutes for vendors with OpenAPI specs.
- **Pairs with item 30 (MCP outbound).** Two paths; partners pick the right one per vendor.
- **Generated source is auditable and hand-editable.** No runtime-OpenAPI dependency.
- **Reuses item 3's HTTP fetcher.** The generated capability is a thin shim over existing infrastructure.

**Risks.**

- **OpenAPI quality varies.** Many real-world specs have missing types, `oneOf` ambiguities, and informal extensions. Mitigation: generator warns on each ambiguity and emits the best-effort Zod with a `TODO: refine` comment; the admin reviews before enablement.
- **Codegen output sprawl.** Specs with hundreds of operations generate hundreds of capabilities. Mitigation: per-operation enable in the import UI; the LLM-binding step (which agents see which capabilities) is unaffected by the count.
- **Spec drift from generated code.** If a vendor revises their spec, regeneration overwrites the file. Mitigation: generated files carry a header marker; regeneration prompts before overwriting; hand-edits are preserved as a `.local.ts` sibling.
- **Arch-decisions misreading.** A future reader sees "OpenAPI generator" and assumes runtime-OpenAPI was reconsidered. Mitigation: the proposal text and the generated-capability file headers both state explicitly that OpenAPI is consumed once at codegen and the Zod schema is the persistent contract.

**Difficulty: Moderate.** Generator CLI + admin upload UI + OpenAPI → Zod conversion (off-the-shelf library available) + Prisma seed emission + auth-mode inference. One sprint.

### Tier summary

The eight items split into three sub-groups by motivation rather than by surface area.

- **Items 29 and 30 are commercial-priority.** GDPR end-user erasure is the most common procurement objection in regulated verticals — it is what closes (or kills) the pilot before quality even gets to make its case. MCP outbound multiplies the integration surface every other partner-facing item benefits from. Both unblock work, rather than improve it.
- **Items 31 through 33 are operational-symmetry.** Knowledge-base freshness, voice output, and per-end-user cost attribution each complete a primitive that shipped one-sided. None is load-bearing on its own; together they remove the "we have half of that" answer from demo conversations.
- **Items 34 through 36 are velocity-multipliers.** Stubbed-execution dry-run lowers the cost of authoring workflows that touch real systems; canary routing lowers the cost of upgrading a published version; OpenAPI-driven capability generation lowers the cost of every new vendor integration. Each item earns its keep on the second or third use, not the first.

Sequenced for shortest path to commercial / engineering / quality leverage: **29 → 30 → 31 → 32 → 33 → 34 → 35 → 36**, with **29** first because procurement is a binary gate, **30** second because every external MCP server is a free integration, and **35** deferred until **23a** has shipped and a partner has explicitly asked for the live-traffic complement to replay. Items 32 and 33 are opportunistic — pick them up when the consumer-shaped audiences from items 24 / 25 / 26 are live and asking. Items 34 and 36 reward themselves on the second use; pick them up when the workflow-author or vendor-onboarding cost is felt for the second time, not the first.

The unifying property: every Tier 7 item points at an existing Sunrise primitive and says "this primitive ships only its outbound half." That is why these belong together — not as miscellaneous gaps, but as the obvious second halves of features that already shipped.

---

## Tier 8 — Proposed: pre-launch foundation — reliability, operational trust, and partner-readiness

A fourth category of proposed work focused on **hardening what's already built** rather than extending what the platform does. Where Tier 5 deepens _what an agent is_, Tier 6 widens _where the agent reaches_, and Tier 7 closes _missing halves of primitives_, Tier 8 closes the **load-bearing reliability, operability, and partner-trust gaps** that determine whether a serious partner can confidently build on Sunrise as a foundation. Three observations frame the shape:

- **Several reliability primitives exist as fragments.** Idempotency is opt-in on one outbound capability; outbound webhook retry policy is hardcoded; cost caps are monthly only. Each fragment was the right MVP at the time, but together they leave the platform short of a coherent correctness story for partners doing anything with side-effects (billing, notifications, ticket creation, downstream writes).
- **Observability is split between traces and a quality dashboard.** Item 10 (trace viewer) is per-execution; item 22 (feedback-loop health) is per-quality-signal. There is no first-party operational dashboard answering "is the engine itself healthy?" and no live page answering "what is it doing right now?"
- **Partner-facing surfaces are documentation-only.** 65+ admin routes are prose-documented; the embed widget is a `<script>` tag; the audit log has no tamper-evidence; conversations have no exportable provenance. Pre-launch is the moment to fix these — every one is harder to retrofit once partner code exists against the current shape.

Items 37–39 are correctness — they prevent silent damage. Items 40–43 are observability and operational control — they make the running system inspectable and tunable. Items 44–45 are developer experience — they multiply partner integration velocity. Items 46–47 are audit defensibility — they answer compliance questions. Items 48–49 are partner trust — they unblock public-sector pilots and remove vendor-lock-in concerns.

| #   | Improvement                                                    | Value         | Effort       | Status         |
| --- | -------------------------------------------------------------- | ------------- | ------------ | -------------- |
| 37  | End-to-end idempotency model                                   | Very high     | Moderate     | ⚪ Not started |
| 38  | Outbound webhook retry policy + dead-letter queue              | High          | Low–Moderate | ⚪ Not started |
| 39  | Per-execution hard cost cap (runaway-loop guard)               | High          | Low–Moderate | ⚪ Not started |
| 40  | Stuck-execution / live-engine admin surface                    | Very high     | Moderate     | ⚪ Not started |
| 41  | Workflow-execution health dashboard (operational, not quality) | Moderate      | Moderate     | ⚪ Not started |
| 42  | Capability emergency-disable / quarantine                      | Moderate      | Low–Moderate | ⚪ Not started |
| 43  | Orchestration-specific load + chaos test harness               | Moderate–High | Moderate     | ⚪ Not started |
| 44  | Orchestration admin API OpenAPI + generated SDK                | High          | Moderate     | ⚪ Not started |
| 45  | Embed widget as installable npm package                        | Moderate–High | Low–Moderate | ⚪ Not started |
| 46  | Audit-log tamper-evidence (hash chain)                         | High          | Low–Moderate | ⚪ Not started |
| 47  | Conversation provenance bundle                                 | High          | Moderate     | ⚪ Not started |
| 48  | WCAG 2.1 AA conformance — orchestration surfaces only          | Very high     | Moderate     | ⚪ Not started |
| 49  | Orchestration data portability — transactional-data extension  | Moderate      | Moderate     | ⚪ Not started |

### 37. End-to-end idempotency model — ⚪ Not started

**Why it matters.** Sunrise sits between three retry surfaces: inbound (clients retrying against admin / consumer APIs), engine-internal (step retries via `maxRetries`), and outbound (webhook deliveries, capability HTTP calls). At each boundary, "the same logical operation happens twice" is a real failure mode — a retried mobile chat POST creates two conversations, a retried workflow execution fires the side-effect twice, an outbound webhook receiver has no platform-supplied way to dedupe duplicate deliveries. For partners building on Sunrise to do anything with side-effects (billing, notifications, ticket creation, downstream writes), the absence of a coherent idempotency story is a correctness gap, not a hardening concern. Cheap to add now; expensive to retrofit once partner code is built against the current shape.

**What exists today.** Outbound HTTP capability (`call-external-api`) has opt-in `autoIdempotency` that injects a UUID `Idempotency-Key` header per call (`lib/orchestration/capabilities/built-in/call-external-api.ts` lines 88–91, test-covered). That is the only idempotency surface. Outbound webhook dispatcher (`lib/orchestration/webhooks/dispatcher.ts` lines 213–221) sends `X-Webhook-Signature` and `X-Webhook-Event` only — no `Idempotency-Key`. Inbound mutating routes (`POST /api/v1/chat`, `POST /api/v1/workflows/{id}/execute`, plus the admin POSTs that create agents / conversations) do not read or validate an `Idempotency-Key` header. The capability dispatcher (`lib/orchestration/capabilities/dispatcher.ts`) dedupes concurrent identical calls via `dispatch-cache.ts` but has no protection against retries that arrive after the original returns.

**What we'd ship.**

1. **Outbound webhook header.** Add an `Idempotency-Key` header to every webhook delivery derived from `AiEventHookDelivery.id` (or a deterministic content hash so retries of the same delivery carry the same key). Document in `.context/orchestration/hooks.md` so partners can dedupe on it.
2. **Inbound idempotency middleware.** New `lib/api/idempotency.ts` middleware reads the `Idempotency-Key` request header, persists `(idempotencyKey, userId, route, responseHash, statusCode, expiresAt)` in a new `AiIdempotencyKey` table (TTL 24h, indexed on `(userId, route)`), and returns the cached response body+status on duplicate keys. Apply to `POST /chat`, `POST /workflows/{id}/execute`, `POST /admin/orchestration/agents`, `POST /admin/orchestration/conversations`, and any new mutating route via decorator/wrapper.
3. **Capability dispatcher replay-after-completion.** Extend `dispatch-cache.ts` to honour a caller-supplied `idempotencyKey` arg: a capability call with a previously-seen key within a configurable window returns the previously-computed result (with `costUsd = 0` on the replay row) instead of re-executing.
4. **Streaming-route nuance.** `POST /chat` streams SSE — replay of a stream is not meaningful. Idempotency applies only to the conversation-creation/turn-creation step; a retried request returns the existing turn's `messageId` plus a `replay: true` flag, and the client re-fetches the message via the existing GET endpoint rather than re-streaming.

**Benefits.**

- **Correctness at every retry boundary.** One mental model across inbound, internal, outbound.
- **Composes with #38 (webhook retry policy + DLQ).** Aggressive retries become safe when receivers can dedupe on `Idempotency-Key`.
- **Composes with item 33 (per-end-user cost).** Duplicate fires today inflate per-user spend; idempotency caps the damage.
- **Extends an existing pattern.** The `autoIdempotency` flag on `call-external-api` is the proof-of-concept; we are generalising, not inventing.

**Risks.**

- **Idempotency-cache row growth.** A 24h cache across every mutating route accumulates rows. Mitigation: dedicated table with TTL pruning via the maintenance tick (item 8 plumbing); indexed on `(userId, route)`; per-key max body size before truncation.
- **Streaming-response semantics.** Replay of an SSE stream is not meaningful. Mitigation: return `{ replay: true, messageId }` and let the client re-fetch — explicit and documented.
- **Admin-route over-application.** Some admin routes (e.g. evaluation bulk-actions) may want last-write-wins, not idempotent. Mitigation: middleware is opt-in per route; default off; admin POSTs opt in case-by-case.

**Priority justification.** Top-3 Tier 8 priority. Cheap to add now; expensive to retrofit later. The current `autoIdempotency` pattern is already proven in code, so this is "extend a known pattern" rather than "design a new abstraction." Correctness gaps compound silently — a partner that builds against the current shape and discovers duplicate-fire issues weeks later is a worse outcome than a sprint of work now.

**Difficulty: Moderate.** One new table + one middleware module + two route-set applications + outbound webhook header + dispatcher extension + docs + one recipe. One sprint, well-bounded.

### 38. Outbound webhook retry policy + dead-letter queue — ⚪ Not started

**Why it matters.** `AiEventHookDelivery` tracks retries today, but the retry policy is hardcoded — `MAX_ATTEMPTS = 3`, `RETRY_DELAYS_MS = [10_000, 60_000, 300_000]` in `lib/orchestration/webhooks/dispatcher.ts` lines 31–35. When a partner's receiver is degraded for an hour, what does Sunrise do? Three attempts spread across ~6 minutes, then give up — and the failed deliveries sit in `AiEventHookDelivery` but the admin has no UI to inspect them, replay them, or hold-and-retry-later. For any production-shaped partner pilot, this is "we lost data and no one noticed."

**What exists today.** Hardcoded retry constants in `webhooks/dispatcher.ts`. `AiEventHookDelivery` records every attempt with status, error, latency. A `/deliveries` API route exists at `app/api/v1/admin/orchestration/webhooks/[id]/deliveries/route.ts`. The admin webhooks page (`app/admin/orchestration/webhooks/page.tsx`) lists subscriptions but does not surface failed deliveries or expose any DLQ UI. `AiEventHook` schema has no `retryPolicy` column; retry behaviour is global.

**What we'd ship.**

1. **Per-hook retry policy.** Add `AiEventHook.retryPolicy Json?` carrying `{ maxAttempts, backoffStrategy: 'exponential' | 'linear' | 'fixed', baseDelayMs, maxDelayMs, jitter }`. Default to the current hardcoded values when null so existing hooks are unaffected. Validate via Zod in `lib/validations/event-hooks.ts`.
2. **Dead-letter state.** Add `AiEventHookDelivery.state` enum (`pending` / `succeeded` / `failed` / `dead-lettered` / `manually-replayed`) and `deadLetteredAt` timestamp. The dispatcher transitions `failed → dead-lettered` after `maxAttempts` is exhausted; nothing auto-retries dead-lettered deliveries.
3. **DLQ admin UI.** New `app/admin/orchestration/webhooks/[id]/dlq/page.tsx` (or a tab on the existing hook detail page) listing dead-lettered deliveries with payload preview, last error, status code, attempt timeline. Per-row "Replay" action that re-queues the delivery with attempt counter reset. Bulk-replay with confirmation.
4. **Retry-policy UI.** New panel on the hook form with retry-policy fields and FieldHelp linking to a recipe explaining backoff curves and when to use each.

**Benefits.**

- **Production-grade reliability.** Hooks become tunable per partner — chatty receivers get aggressive retries, sensitive receivers get gentle ones.
- **Operator confidence.** "We lost a webhook and no one noticed" stops being possible — DLQ surfaces every failed delivery.
- **Composes with #37 (idempotency).** Aggressive retries (e.g. 10 attempts over 24h) are safe when receivers dedupe on `Idempotency-Key`.
- **Reuses existing storage.** `AiEventHookDelivery` already records every attempt; the change is two new columns and a UI.

**Risks.**

- **Configuration footgun.** Admins setting `maxAttempts: 50` could DoS their own receivers. Mitigation: hard cap at 20 attempts and 7-day max-retry-window in the Zod schema; admin form rejects beyond the cap.
- **DLQ growth.** Dead-lettered deliveries accumulate indefinitely if no one replays them. Mitigation: respect `webhookRetentionDays` — dead-lettered rows older than retention are pruned by the maintenance tick.
- **Replay safety.** Replaying a dead-lettered delivery weeks after the event may be wrong (state has moved on). Mitigation: replay panel shows event age + a "this event is N days old — sure?" confirmation for stale replays.

**Priority justification.** Top-3 Tier 8 priority. Production-readiness gap; partners with real receivers will hit this within the first month of any pilot. The current behaviour (silently give up after 6 minutes) is not defensible in any production conversation. Schema is additive; backward-compatible.

**Difficulty: Low–Moderate.** Two additive Prisma columns + dispatcher policy lookup + new admin page + retry-policy form panel. Half-to-one sprint.

### 39. Per-execution hard cost cap (runaway-loop guard) — ⚪ Not started

**Why it matters.** `AiAgent.monthlyBudgetUsd` caps spend over a month, enforced by `checkBudget()` at `lib/orchestration/llm/cost-tracker.ts` lines 417–476. What it does not cap is a single misbehaving execution. A `reflect` loop that doesn't converge, an `orchestrator` re-planning 50 times, a tool-call loop with a misbehaving capability — any of these can spend a hundred dollars within a single execution before any quality signal fires. The platform tracks a `budgetLimitUsd` parameter at execution-creation time on `AiWorkflowExecution`, but this is a per-execution _record_, not enforced incrementally as the execution runs.

**What exists today.** Monthly budget enforcement only. `budgetLimitUsd` is stored on `AiWorkflowExecution` rows but the engine does not consult it inside the run. No `maxCostPerExecutionUsd` or `maxCostPerTurnUsd` fields on `AiAgent` or `AiWorkflow`. No inline check inside `reflect`, `orchestrator`, or `tool-call` executors.

**What we'd ship.**

1. **Schema additions.** `AiAgent.maxCostPerTurnUsd Float?`, `AiWorkflow.maxCostPerExecutionUsd Float?`, plus org-wide defaults on `AiOrchestrationSettings.defaultMaxCostPerExecutionUsd` and `defaultMaxCostPerTurnUsd`.
2. **Inline enforcement.** Inside the engine's per-step cost roll-up (`lib/orchestration/engine/`), after every cost-emitting step (`llm-call`, `tool-call`, `external-call`, `rag-retrieve`, evaluations), compare the running execution total against the configured cap. On breach: terminate the execution with a `BUDGET_EXCEEDED_PER_EXECUTION` error, write a clear trace entry, fire a new `workflow.budget_exceeded` hook event.
3. **Per-turn enforcement on chat.** The streaming chat handler (`lib/orchestration/chat/`) rolls up cost per assistant turn (LLM + tool calls + RAG). When the running turn cost crosses `maxCostPerTurnUsd`, the tool loop stops (no more iterations) and the partial answer is returned with a `budget_exceeded_per_turn` metadata flag.
4. **Admin form integration.** Agent form's "Routing" tab gains `maxCostPerTurnUsd` with FieldHelp explaining the runaway-loop framing. Workflow form's "Budget" section gains `maxCostPerExecutionUsd`. Both nullable; null means "no per-call cap, monthly budget applies."

**Benefits.**

- **Stops runaway spend before it happens.** A bad deployment becomes a $5 mistake instead of a $500 one.
- **Pairs with item 22 (feedback-loop health).** Item 22 catches systemic loop divergence over time; #39 catches the single bad execution before it accumulates.
- **Pairs with item 33 (per-end-user cost).** Defends the per-user cap from a single rogue turn blowing through it.
- **Reuses the existing cost-tracking pipeline.** No architectural change; the in-process running total is already maintained.

**Risks.**

- **False-positive terminations on legitimate long workflows.** A multi-hour batch-style workflow might legitimately spend a lot. Mitigation: per-workflow override on the cap; default is null (= unlimited).
- **Mid-turn cutoff UX.** A chat user sees the answer cut off. Mitigation: the partial answer is returned with a clear `budget_exceeded` marker and a user-facing fallback message configurable per agent.
- **Cost-tracking lag.** If cost-log writes are fire-and-forget, the running total may be stale. Mitigation: enforcement uses the in-process running total maintained inside the engine, not a re-read from `AiCostLog`.

**Priority justification.** Top-5 Tier 8 priority. Small implementation, prevents the single class of "this deployment cost us $500 overnight" incidents that erode platform trust faster than any quality gap. Schema-additive; ships without breaking any existing agents.

**Difficulty: Low–Moderate.** Three Prisma fields + engine-internal check + chat-handler check + two admin form panels + one new hook event. Half-to-one sprint.

### 40. Stuck-execution / live-engine admin surface — ⚪ Not started

**Why it matters.** Item 15 (checkpoint recovery) shipped a lease-based orphan sweep, and the executions admin page supports filtering by status. What's missing is the operational view that answers "what is the engine doing right now, and what's wrong with it?" When a partner reports "my workflow has been running for 20 minutes," today the answer is: open the trace viewer, click through each step, eyeball the timestamps. For partners running cron- or inbound-trigger-driven workflows, this is the first operational problem they hit.

**What exists today.** `app/admin/orchestration/executions/page.tsx` lists executions with status filter (`pending` / `running` / `completed` / `failed`); the `running` filter works. The page does not surface: time-stuck-in-current-step, queue-wait time, current lease holder, force-fail action. Lease-status and orphan-sweep state live in `lib/orchestration/engine/lease.ts` but are not exposed in any admin UI.

**What we'd ship.**

1. **Live-engine page** at `app/admin/orchestration/executions/live`. Auto-refreshing dashboard (SSE push or 5-second poll) showing four cards: currently-running executions (count + p95 age), queued executions (count + max wait-time), orphaned executions (lease-expired, awaiting sweep), and provider-saturation indicators (per-provider in-flight call counts).
2. **Per-execution stuck-state column.** A new computed field `timeInCurrentStepMs` (now - last cost-log timestamp for the execution) surfaced as a sortable column on the live page. Highlight rows where this exceeds a configurable threshold (default 5 minutes) as "stuck-looking."
3. **Force-fail action.** Per-row admin action `POST /api/v1/admin/orchestration/executions/{id}/force-fail` that transitions a running execution to `failed` with an audit-log entry, fires the `workflow.failed` hook, and releases any held lease. Confirmation dialog with execution context.
4. **Lease inspector drill-in.** Per-row panel showing current lease holder, lease expiry, and lease history. Helps debug "I keep seeing the same execution stuck — is the engine restarting?"

**Benefits.**

- **First debugging surface for operational issues.** Today this debugging is "read the trace viewer carefully"; tomorrow it's "open the live page."
- **Composes with #41 (execution health dashboard).** Live page = "right now"; dashboard = "trend over time." Two complementary lenses.
- **Reuses existing infrastructure.** Lease module, executions list, cost-log timestamps — all already there.
- **Closes the obvious item 15 follow-on.** Lease-based sweep without admin visibility is half a feature.

**Risks.**

- **Auto-refresh load.** A live page polling every 5 seconds across multiple admins could pressure Postgres. Mitigation: SSE push from a singleton in-process aggregator that materialises the snapshot once per tick; clients subscribe.
- **Force-fail misuse.** An impatient admin force-fails a slow-but-legitimate execution. Mitigation: confirmation dialog warns about side-effects partially completed; audit-log captures actor and (optional) reason.

**Priority justification.** Top-3 Tier 8 priority. The cheapest operational visibility win — every primitive needed is already in the codebase, the missing piece is the UI. Partner pilots will hit "the workflow is stuck" within the first week of running anything non-trivial.

**Difficulty: Moderate.** New admin page + four cards + computed field + force-fail route + lease drill-in. One sprint.

### 41. Workflow-execution health dashboard (operational, not quality) — ⚪ Not started

**Why it matters.** Item 22 (feedback-loop health) watches quality signals — `reflect` convergence, `evaluate` drift, retry exhaustion. What it doesn't watch is the engine's own operational health: executions/min by workflow, p95 step latency by step type, failure rate by step type, provider-failure rate, queue-wait time. These are the "is the engine healthy?" questions that don't fit into item 22's quality framing. Today these signals exist only if the operator wires OTEL out to Grafana / Datadog (item 13). For partners deploying in-the-box without external observability stacks, there is no first-party answer to "is the system healthy?"

**What exists today.** `app/admin/orchestration/analytics/page.tsx` is engagement-focused (requests, unique users, popular topics, unanswered queries, content gaps). The orchestration dashboard at `app/admin/orchestration/page.tsx` shows cost trends, top capabilities, recent activity, and a single error-rate scalar. Neither surfaces step-level latency percentiles, provider-failure breakdown, queue-wait time, or per-workflow execution rates.

**What we'd ship.**

1. **Dashboard page** at `app/admin/orchestration/observability/execution-health`. Top cards: executions/min (trailing 5m), success rate, p50/p95/p99 execution duration, queue-wait p95. Per-workflow breakdown table sortable on each metric. Per-step-type table showing latency + failure rate per step type (`llm_call`, `tool_call`, `external_call`, `rag_retrieve`, evaluations, etc.). Per-provider panel: success rate per provider, fallback-chain activation rate.
2. **Aggregation queries.** All metrics derived from `AiCostLog` (already records per-step latency, status, provider, model) and `AiWorkflowExecution` (queue-enqueued-at, started-at, completed-at). No new instrumentation; new queries only.
3. **Pre-computed rollups.** A new `AiExecutionHealthRollup` table updated by the maintenance tick (1-minute granularity) so the dashboard reads rollups, not raw cost-log rows.
4. **Threshold alerting.** Per-workflow `degradationThresholds` JSON on `AiWorkflow` carrying optional failure-rate / latency / queue-wait thresholds; breaches fire `execution.health.degraded` hooks consumable by partner Slack / PagerDuty (reuse item 22's hook event pattern).
5. **Time-window picker.** Default trailing 1h; 24h, 7d, 30d options. Sparkline per metric on the per-workflow row.

**Benefits.**

- **First-party operational lens.** Reads the same data OTEL exporters emit, without requiring an external stack.
- **Pairs with item 22 (feedback-loop health) and #40 (live page).** Three complementary observability surfaces — quality, operational, real-time.
- **No new data captured.** Aggregation-only over existing tables.
- **Composes with #38 (DLQ).** Webhook-delivery failure rate joins the dashboard naturally.

**Risks.**

- **Query cost.** Aggregating millions of `AiCostLog` rows for percentiles is expensive. Mitigation: pre-computed rollups in a new `AiExecutionHealthRollup` table updated by the maintenance tick (1-minute granularity); the dashboard reads rollups, not raw logs.
- **Threshold noise.** A new low-volume workflow will breach thresholds on a single failure. Mitigation: sample-size floor before threshold evaluation (default 30 executions over the window).

**Priority justification.** Mid-tier Tier 8 priority. Less urgent than #37–#40 because partners with OTEL stacks already get this from item 13, but high-leverage for the in-the-box deployment profile. Composes cleanly with #40 (live) and item 22 (quality) — building all three creates the full observability story.

**Difficulty: Moderate.** New page + four cards + two tables + aggregation queries + rollup table + threshold-hook event. One sprint.

### 42. Capability emergency-disable / quarantine — ⚪ Not started

**Why it matters.** When an external capability misbehaves at scale — returning malformed data, hanging, rate-limit-exceeded across all calling agents — the admin needs a one-click "stop using this capability across every agent" action, not an "edit each agent's bindings one at a time" tour. The need is rare but acute: the difference between a 5-minute remediation and a 30-minute one when a vendor's API has degraded. Today the closest action is to deactivate the global `AiCapability.isActive` flag, which is a hard delete — every agent loses the capability silently, the bindings persist but no longer resolve, and there's no clear audit signal that "we are in degraded mode."

**What exists today.** Per-agent binding has `AiAgentCapability.isEnabled` (toggle per binding). Global `AiCapability.isActive` (toggle all). No `quarantined` state distinct from full deactivation; no bulk-action UI; no audit-distinguished signal.

**What we'd ship.**

1. **Quarantine state.** Add `AiCapability.quarantineState` enum (`active` / `quarantined-soft` / `quarantined-hard`), plus `quarantineReason String?` and `quarantineUntil DateTime?`. `quarantined-soft`: dispatcher returns a structured error to the agent (the agent sees "tool temporarily unavailable" and can route around it via `plan` / `orchestrator`). `quarantined-hard`: dispatcher refuses dispatch with no fallback path; useful for "this capability is sending wrong data, don't use it at all."
2. **Admin UI on capability detail page.** Big amber "Quarantine" button with mode selector (soft/hard), reason text, optional auto-expiry. Quarantine writes a high-severity audit-log entry with actor and reason; un-quarantine writes the matching un-quarantine entry.
3. **Banner across affected agents.** Every agent that binds a quarantined capability surfaces a banner on its detail page: "Capability X is quarantined (reason: ...) — N tools unavailable until re-enabled."
4. **Hook event.** `capability.quarantined` fires for downstream consumers (Slack alert pattern).

**Benefits.**

- **Five-minute remediation.** Vendor down? One click, every agent picks up the change immediately.
- **Audit trail by design.** Quarantine is auditable, distinct from accidental deactivation.
- **Pairs with #38 (DLQ) and #40 (live page).** A quarantine plus the DLQ tells the full story: "we caught it, here's where the failures went, here's how long we held."

**Risks.**

- **Quarantine forgetting.** Admin quarantines, fixes the upstream, forgets to un-quarantine. Mitigation: optional auto-expiry; admin dashboard shows a count of active quarantines with age.
- **Agent-side cascade.** An agent with a critical quarantined tool may fail every call. Mitigation: agent-detail-page banner makes the impact visible; agent designers can mark capabilities as critical so quarantine triggers an `agent.degraded` hook.

**Priority justification.** Mid-tier Tier 8 priority. Rare incident but acute when it hits; the cost of building is low. Composes naturally with #38 and #40. Worth shipping as part of the operational-readiness cohort.

**Difficulty: Low–Moderate.** Three Prisma fields + dispatcher-side state check + admin form panel + per-agent banner + audit-log integration + one hook event. Half-to-one sprint.

### 43. Orchestration-specific load + chaos test harness — ⚪ Not started

**Why it matters.** Pre-launch credibility. Today `npm run smoke:chat` and a handful of other smoke scripts exercise basic end-to-end wiring against the dev DB. None of them sustain load, none of them simulate provider failure, none of them have published baselines. For partners evaluating whether to commit production traffic, "have you load-tested this?" is binary — and the answer today is "we have smoke tests." Pre-launch is the cheap moment: traffic shapes can be designed against the worked-example scenarios in `business-applications.md`; baselines establish a regression bar for every subsequent sprint.

**What exists today.** `npm run smoke:*` in `package.json` (chat, orchestration, transcribe, hybrid-search, vision) under `scripts/smoke/`. No `scripts/load/`, no `scripts/chaos/`, no k6 / artillery / autocannon usage. No published baseline metrics anywhere in `.context/`.

**What we'd ship.**

1. **Load scripts under `scripts/load/`.** k6 (preferred — single binary, no Node dependency) scripts for: concurrent chat conversations against a real workflow (`load-chat.js`), workflow throughput (`load-workflow.js` — sustained executions/sec), inbound trigger stress (`load-inbound.js` — Slack-style burst), hybrid-search throughput (`load-search.js`). Each script accepts `--vus`, `--duration` parameters and emits a JSON results bundle.
2. **Chaos scripts under `scripts/chaos/`.** `chaos-provider-flap.ts` (configures a primary provider to return 503 for N seconds, verifies fallback chain activates), `chaos-db-saturation.ts` (saturates Postgres connection pool, verifies graceful degradation), `chaos-queue-flood.ts` (floods the async-execution queue, verifies queue-wait p95 and orphan-sweep behaviour).
3. **Published baselines.** A new `.context/orchestration/load-baselines.md` documenting the platform's claims: "1000 concurrent chat conversations sustained at p95 < 2s on 4 vCPU / 8GB Postgres", "500 workflow executions/sec sustained for 10 minutes", "Slack-burst 5000 events/sec absorbed without backpressure" — with the exact `npm run loadtest:*` command that reproduces each.
4. **CI integration.** Optional nightly run via GitHub Actions hitting an ephemeral environment; results commit to a `.load-history/` directory so regressions surface as PR diffs.

**Benefits.**

- **Pre-launch credibility.** The claim "we have load-tested this to X" becomes a defensible answer in partner conversations.
- **Regression bar.** Every subsequent perf-sensitive PR can be evaluated against the baseline.
- **Composes with #41 (health dashboard).** The dashboard makes the load-test results visible in real time as the test runs.

**Risks.**

- **Ephemeral-environment cost.** Nightly CI load tests against a real Postgres + Redis cost money. Mitigation: nightly is opt-in via GH Actions cron; PR-gated load tests run only when label is applied; baselines update on tagged release only.
- **k6 vs Node-only.** k6 is a separate binary; some teams prefer Node-only. Mitigation: ship k6 with a Node fallback (autocannon-based) for partners who want Node-only.

**Priority justification.** Mid-tier Tier 8 priority. Pre-launch credibility matters; once partners are running production traffic, retrofitting load tests is harder because there's no clean baseline to claim. Half-to-one sprint of focused work + ongoing tuning. Build the scripts now, claim the baselines once they stabilise.

**Difficulty: Moderate.** k6 scripts + chaos scripts + baseline docs + optional CI workflow. One sprint.

### 44. Orchestration admin API OpenAPI + generated SDK — ⚪ Not started

**Why it matters.** 65+ orchestration admin routes are documented as prose in `.context/api/orchestration-endpoints.md`. A partner wanting to script against admin — bulk-deploy 50 agents from a config repo, automate KB updates from a CMS, integration-test their workflow against a real Sunrise — has nothing typed to import. Tooling velocity (both internal and partner) is bounded by the lack of a machine-readable contract. Auto-generating an OpenAPI spec from the existing Zod schemas via `zod-openapi` and emitting a TypeScript client via `openapi-typescript` is well-trodden ground; the work is wiring, not invention.

**What exists today.** Zero OpenAPI dependencies in `package.json` (`zod-openapi`, `openapi-typescript`, `@asteasolutions/zod-to-openapi` all absent). Zero `*.openapi.ts` / `openapi.json` / `swagger.json` files. Admin route handlers each use Zod for validation but the schemas are not aggregated into a single contract surface. No `packages/` directory.

**What we'd ship.**

1. **OpenAPI generation.** Add `zod-openapi` (or `@asteasolutions/zod-to-openapi`). A new `lib/api/openapi-registry.ts` collects route metadata (path, method, request schema, response schema, error envelope) registered by each admin route as a side-effect of import. A new `npm run generate:openapi` walks the route tree, builds an OpenAPI 3.1 document, writes `openapi/admin-orchestration.json`.
2. **SDK generation.** `openapi-typescript` consumes the JSON and emits `packages/orchestration-admin-sdk/src/types.ts` (typed paths) plus a thin handwritten client wrapper using `fetch` with auth-header injection.
3. **Publish posture.** Generated SDK lives in a `packages/` directory (introduces npm workspaces — small repo restructure). Published as `@sunrise/orchestration-admin-sdk` to npm on tagged release.
4. **OpenAPI-served route.** New `GET /api/v1/admin/orchestration/openapi.json` serves the generated spec for partners who want to feed it into Postman / Swagger UI / their own codegen.
5. **Internal test-suite migration.** Internal admin-route tests migrate from raw `fetch` calls to the typed SDK, surfacing route changes as type errors at PR time.

**Benefits.**

- **Multiplies tooling velocity.** Internal tests + partner scripts + Postman collections all derive from one source.
- **Surfaces contract drift at PR time.** A route schema change becomes a type error in the SDK and tests.
- **Pairs with #45 (embed npm package).** Same workspaces foundation; same publish discipline.
- **Reuses existing Zod schemas.** No second source of truth; OpenAPI is generated, not authored.

**Risks.**

- **Workspaces refactor.** Adding `packages/` is a repo-shape change. Mitigation: keep the main app at the root; only the SDK lives under `packages/`; lockfile-pin is the only widely-felt change.
- **Schema coverage.** Some routes (file uploads, SSE) don't map cleanly to OpenAPI. Mitigation: those routes are documented with an `x-non-openapi` extension and a manual SDK section; everything else generates cleanly.
- **Version drift after publish.** Once the SDK is on npm, downstream pinning matters. Mitigation: semver discipline + a `CHANGELOG.md` in `packages/orchestration-admin-sdk` generated from PR titles.

**Priority justification.** Top-5 Tier 8 priority. The DX multiplier is real — every internal integration test, every partner integration script, every documentation example benefits. Pre-launch is the right moment because the API shape is still malleable; post-launch, every change risks breaking partner code.

**Difficulty: Moderate.** OpenAPI registry module + generator script + SDK package skeleton + workspaces setup + one new served route + test-suite migration. One sprint.

### 45. Embed widget as installable npm package — ⚪ Not started

**Why it matters.** Today the embed widget is `<script src="https://your.sunrise/api/v1/embed/widget.js">` — a vanilla Shadow-DOM ES5 bundle that mounts itself. This is fine for static-site partners but feels Web 1.0 for the many partners with React / Vue / Svelte apps who want a type-safe component, declarative props, and lifecycle events. The widget loader itself stays (some partners genuinely don't have a build pipeline), but the gap is the absence of a first-party companion package: `@sunrise/embed-react` exposing `<SunriseChat agentToken={...} onMessage={...} theme={...} />`.

**What exists today.** Vanilla widget at `app/api/v1/embed/widget.js/route.ts` (Shadow DOM, plain ES5, self-contained). Admin embed-config UI at `components/admin/orchestration/agents/embed-config-panel.tsx` (internal — generates the `<script>` snippet for partners to copy). No `packages/` directory; no published wrapper packages.

**What we'd ship.**

1. **`packages/embed-react/`.** A small package exposing `<SunriseChat>` and `<SunriseChatButton>` (floating-button variant). Props are typed: `agentToken`, `apiBaseUrl`, `theme` (object derived from `widgetConfig`), `welcomeMessage`, plus event callbacks (`onConversationStarted`, `onMessage`, `onCardSubmit`, `onError`). Internally, the package dynamically imports the vanilla widget's logic (or re-implements the small surface as a thin React layer) — the vanilla widget remains the source of truth so behaviour is identical.
2. **`packages/embed-vue/` and `packages/embed-svelte/`.** Same shape, framework-idiomatic. Ship React first; add Vue / Svelte only when a partner asks.
3. **Theme tokens.** A typed `WidgetTheme` interface exporting every customisable token from `widgetConfig`; package consumers get autocomplete.
4. **CDN ESM build.** Same package available via `https://unpkg.com/@sunrise/embed-react@latest/dist/index.mjs` for partners doing import-map / `<script type="module">`.
5. **Docs.** Worked examples for each framework in the package READMEs + a section in `.context/orchestration/embed.md`.

**Benefits.**

- **Modern partner DX.** Type-safe, declarative integration matching how partners build today.
- **Same behaviour, different surface.** The vanilla widget remains the source of truth; the packages are thin wrappers.
- **Pairs with #44 (admin SDK).** Both packages live under `packages/`; same publish pipeline; same workspaces setup.
- **Reduces partner onboarding friction.** The `<script>` snippet still works for partners who want it; the npm path is for partners who want better DX.

**Risks.**

- **Three-framework maintenance burden.** React + Vue + Svelte triples the surface. Mitigation: ship React first (the largest partner audience); add Vue / Svelte only when a partner asks. Document the extension path so community contributions are tractable.
- **Vanilla-widget-and-react-package drift.** Two implementations risk diverging. Mitigation: React package depends on the vanilla widget as a peer dep; the wrapper is documented as "thin layer," not a re-implementation.
- **Type-only changes breaking partners.** A theme-token rename breaks every consumer's tsc. Mitigation: semver discipline; major-version bumps for breaking type changes.

**Priority justification.** Top-7 Tier 8 priority. Lower than #44 because the `<script>` path works today; higher than #43 because partner-facing DX directly affects pilot velocity. Ship React first; defer Vue / Svelte. Pre-launch is the right moment to establish the package + versioning shape.

**Difficulty: Low–Moderate (React only).** Workspaces setup (shared with #44) + React wrapper + theme-token export + docs. Half-to-one sprint for React. Each additional framework: half a sprint.

### 46. Audit-log tamper-evidence (hash chain) — ⚪ Not started

**Why it matters.** Compliance auditors in regulated verticals (legal, finance, health, public sector) ask one specific question of every audit log: "can you prove no one has tampered with this?" Today `AiAdminAuditLog` records every admin mutation with fields for `userId`, `action`, `entityType`, `entityId`, `changes`, `metadata`, `clientIp`, `createdAt` — but every one of those rows is mutable at the database level without detection. A hash chain (each row carries the hash of the previous row plus its own content; a periodic signature on the chain head) makes tampering detectable and is table-stakes for partners going through SOC 2 / ISO 27001 audits.

**What exists today.** `AiAdminAuditLog` schema has no `prevHash`, `contentHash`, `signature`, or `chainHeadSignature` fields. No verification logic in `lib/orchestration/audit/`. No periodic chain-head signing.

**What we'd ship.**

1. **Schema additions.** `AiAdminAuditLog.prevHash String?` (SHA-256 of the previous row's `contentHash` in this chain), `contentHash String` (SHA-256 of `userId | action | entityType | entityId | changes | metadata | createdAt`), `chainPosition Int` (monotonic, with a per-table sequence). Computed at insert time inside the same transaction as the audit-row insert.
2. **Chain-head signing.** Every N minutes (configurable; default 15), a maintenance-tick job reads the latest row, signs its `contentHash` with a system-private-key, writes the signature to a new `AiAuditChainHead` table. The system-public-key is exposed via `GET /api/v1/admin/orchestration/audit/public-key`.
3. **Verification route.** `POST /api/v1/admin/orchestration/audit/verify` walks the chain backwards from the latest signed head, recomputes each `contentHash`, recomputes each `prevHash` link, returns `{ verified: true, lastSignedAt }` or `{ verified: false, firstBrokenRowId }`. Available in admin UI as a "Verify integrity" button on the audit-log page.
4. **Erasure interop.** When item 29 (GDPR erasure) redacts a row, the row's `contentHash` does not change (it's the hash of the original content, immutable); only the user-visible content fields are nulled. Verification still passes.

**Benefits.**

- **Compliance audit table-stakes.** Partners hand auditors a signed verification result, not a screenshot.
- **Composes with item 29 (GDPR erasure).** Erasure-redacts user content without breaking the integrity chain — the chain proves the row existed and when it was redacted.
- **Small implementation.** Additive schema, deterministic hashing, one verification route, one signing job.

**Risks.**

- **Signing-key management.** Where does the private key live? Mitigation: derived from `BETTER_AUTH_SECRET` (or a dedicated `AUDIT_SIGNING_SECRET` env var) at boot; documented as "rotate via env-var change + chain re-anchor migration."
- **Verification cost.** A million-row chain takes time to walk. Mitigation: signed chain-heads checkpoint the chain — verification only re-walks rows since the last signed head (typically < 15 minutes' worth).
- **Schema-additive risk on existing rows.** Existing audit rows have no `prevHash` / `contentHash`. Mitigation: a one-shot back-fill migration computes the chain from row-creation order; existing rows get retroactive hashes, future rows are chained inline.

**Priority justification.** Top-7 Tier 8 priority. Small implementation, large credibility gain. Defers cleanly until a partner actually goes through an audit, but the moment one does, "we have a hash chain with periodic signing" is the difference between a 30-minute conversation and a six-week remediation project. Ship before the first regulated-vertical pilot.

**Difficulty: Low–Moderate.** Three Prisma fields + one new table + insert-time hashing + signing tick + verification route + admin button + back-fill migration. Half-to-one sprint.

### 47. Conversation provenance bundle — ⚪ Not started

**Why it matters.** For legal-advice, mortgage-broking, tenant-rights, council-planning, health-protocol, financial-planning pilots, the conversation itself is the audit artefact partners hand to their reviewers. The question "show me how the agent arrived at this answer on this date" needs a defensible answer, not a SQL join across half a dozen tables. Today `AiMessage` does not record the agent version, workflow version, model ID, or KB chunks cited at message time — reconstructing this requires inferring from execution traces and citation envelopes, and the inference is lossy if the agent was edited or knowledge re-ingested between the message and the audit. Pre-launch is the cheap moment to add the pinning; post-launch retrofitting it means every legacy message carries a "pre-vN" asterisk.

**What exists today.** Conversation export route at `app/api/v1/admin/orchestration/conversations/export/route.ts` returns JSON/CSV with `conversationId`, `agentId`, `agentSlug`, `agentName`, messages, timestamps — but no per-message agent version / workflow version / model ID, no KB chunks cited, no capability calls made. `AiMessage` has no `agentVersionId` / `workflowVersionId` / `modelId` fields. Item 2 (citations) captures KB chunks in the citation envelope (in-band on the rendered message) but not in the export. Item 12 (workflow versioning) pins `AiWorkflowExecution.versionId` but not per-message. Reconstructing "what was running when this message was sent" requires manual joins across `AiConversation → AiWorkflowExecution → AiWorkflowVersion`.

**What we'd ship.**

1. **Per-message version pinning.** Add `AiMessage.agentVersionId String?`, `AiMessage.workflowVersionId String?` (nullable; populated for workflow-fired messages), `AiMessage.modelId String?`, `AiMessage.providerSlug String?`. The chat handler writes these at message-creation time.
2. **Per-message citation pinning.** Add `AiMessage.citations Json?` carrying the resolved chunk refs at message time: `[{ chunkId, documentId, documentVersion, contentHash }]`. Item 31 (KB freshness scanner) makes `documentVersion` meaningful.
3. **Per-message capability pinning.** Add `AiMessage.capabilityCalls Json?` carrying `[{ capabilityId, capabilitySlug, capabilityVersion, args, result, costUsd, latencyMs }]` for the tool calls that produced the message.
4. **Provenance endpoint.** `GET /api/v1/admin/orchestration/conversations/{id}/provenance` returns the full bundle: every message with its pinned versions + citations + capability calls, plus conversation-level metadata (start time, end time, total cost, agent-version transitions during the conversation, model-routing decisions). Output format: JSON, plus a PDF rendering via the Gotenberg recipe (chains item 17). Composes with item 27 (conversation export) — the export is the _conversation_; provenance is the _audit trail_.

**Benefits.**

- **Audit defensibility.** Partners hand auditors a versioned provenance bundle, not "trust us, we logged it."
- **Composes with item 12 (versioning), item 2 (citations), item 31 (freshness).** Every existing primitive that pins state at one level becomes per-message-pinned.
- **Pre-launch timing matters.** Retrofitting version pinning to existing messages means accepting a "pre-vN messages don't have provenance" carve-out.

**Risks.**

- **Row growth.** Four new columns × millions of messages × JSON for citations and capability-calls. Mitigation: citations and capability-calls are JSONB; pruning policy via the existing retention plumbing.
- **Provenance-export cost.** A long conversation with deep citations produces a large bundle. Mitigation: page the provenance endpoint by message ranges; PDF rendering is opt-in.
- **Schema migration on existing messages.** Existing messages lack version pins. Mitigation: a best-effort back-fill migration joins against `AiWorkflowExecution.versionId` and the conversation's then-current agent version; rows that can't be back-filled get a `provenance: 'partial'` marker.

**Priority justification.** Top-7 Tier 8 priority. The kind of feature whose absence is invisible until a compliance audit asks for it; cheap to add pre-launch; expensive to retrofit post-launch. Composes with multiple existing items, so the marginal cost of building it is lower than implied by the row counts.

**Difficulty: Moderate.** Four Prisma fields + chat-handler write integration + provenance route + PDF rendering recipe + back-fill migration. One sprint.

### 48. WCAG 2.1 AA conformance — orchestration surfaces only — ⚪ Not started

**Why it matters.** Required for any public-sector partner — council, NHS, education, regulated charities — and increasingly a procurement-checklist item in private-sector pilots too. The audit dimensions are well-defined: keyboard navigation, screen-reader support (ARIA), color contrast, focus management, form labels. The platform has baseline tooling but no systematic audit, no automated regression gate, and conspicuous gaps in some recently-shipped components (chat, agent test surfaces, embed widget). Public-sector audiences are central to `business-applications.md`; this is not a polish item, it's a procurement blocker.

**What exists today.** `eslint-plugin-jsx-a11y` v6.10.2 configured in `eslint.config.mjs`. Sampled orchestration components: 8 of 10 have ARIA attributes; 2 (`agent-test-card.tsx`, `execution-progress-inline.tsx`) lack them. Targeted contrast test for the embed widget customisation form at `tests/unit/components/admin/orchestration/widget-appearance-section.test.tsx` validates contrast ratio ≥ 4.5. No axe-core / jest-axe in `package.json`. No keyboard navigation tests, no focus-management tests, no screen-reader-output assertions. No accessibility audit docs in `.context/`. The embed widget (vanilla Shadow DOM) has no documented ARIA.

**What we'd ship.**

1. **Automated regression gate.** Add `jest-axe` (vitest-compatible) to the test suite. A new test pattern `tests/a11y/<page>.spec.tsx` renders each orchestration admin page and asserts zero axe violations. Add a `:axe` filter to `npm run test` for fast feedback during development. CI runs the full a11y suite on every PR.
2. **Manual audit pass.** A one-time systematic walk through `app/admin/orchestration/**`, `components/admin/orchestration/**`, the embed widget, and the consumer chat. Audit checklist captured in `.context/ui/accessibility.md`. Remediation PRs land file-by-file (small, reviewable changes).
3. **Embed widget ARIA pass.** The vanilla Shadow-DOM widget gains explicit `role`, `aria-live`, `aria-label`, keyboard focus management, and a documented contract for partners embedding it (Permissions-Policy, focus-trap behaviour, Esc-to-close).
4. **Component-library defaults.** The shared form / button / dialog components get ARIA defaults so new components inherit them rather than re-implementing.
5. **Conformance doc.** `.context/ui/accessibility.md` documents the audit methodology, the level of conformance claimed (WCAG 2.1 AA), known exceptions with rationale, and the test surfaces that gate regressions.

**Benefits.**

- **Public-sector pilot unblock.** Partners in council / NHS / education / regulated charity sectors get a defensible "yes" to the procurement checkbox.
- **Catches future regressions automatically.** A PR that introduces an a11y violation fails CI rather than shipping.
- **Pairs with item 26 (structured cards).** Card components get a11y defaults from day one.
- **Existing baseline is solid.** ESLint plugin already running; 8 of 10 sampled components already conform; the gap is systematic not catastrophic.

**Risks.**

- **Remediation time.** Manual audit + remediation is the longest work-tail. Mitigation: file-by-file PRs; lock new orchestration pages to "axe-clean" before merge; tolerate a known-exceptions list for existing pages until they're touched.
- **Embed-widget complexity.** Shadow-DOM + ES5 makes a11y harder than React. Mitigation: focus on the WCAG basics (keyboard, contrast, focus trap, ARIA roles); defer screen-reader nuances if cost outweighs partner-pull.
- **Test flakiness.** axe assertions on complex pages can be noisy. Mitigation: per-test rule allowlists; minor color-contrast wins via design-token review, not test-suppression.

**Priority justification.** Top-3 Tier 8 priority. Unblocks the public-sector partner audiences `business-applications.md` explicitly targets. The cost is concentrated in the manual audit; the automated gate makes subsequent work cheap. Pre-launch is the right moment because audit + remediation against 30+ pages is a known-scope sprint, vs. a moving target post-launch.

**Difficulty: Moderate (audit + remediation = 1–2 sprints).** Jest-axe integration + a11y test pattern + manual audit walk + remediation PRs + embed-widget ARIA pass + component-library defaults + conformance doc.

### 49. Orchestration data portability — transactional-data extension — ⚪ Not started

**Why it matters.** A partner that commits production traffic to Sunrise needs to know the exit path. "If we decide to leave, can we take our data with us?" is a binary procurement question and the answer today is "configuration yes, conversations and audit history no." The existing exporter exports configuration (agents, capabilities, workflows, knowledge tags, webhooks, settings) but explicitly excludes conversations, messages, embeddings, cost logs, execution history, audit logs, evaluation logs — by design, for the "clone-and-redeploy" use case. That design choice leaves vendor-lock-in concerns unaddressed for partners thinking about long-term commitment.

**What exists today.** Backup export route at `app/api/v1/admin/orchestration/backup/export/route.ts`. Library at `lib/orchestration/backup/exporter.ts`. Admin UI in the settings tab. Documented exclusions at `.context/orchestration/backup.md` lines 36–42 — transactional data is explicitly out of scope. Tests at `tests/integration/api/v1/admin/orchestration/backup/export.test.ts` cover the config-only path.

**What we'd ship.**

1. **Two-tier export.** Existing config-only export stays. Add a new "full export" mode (`POST /api/v1/admin/orchestration/backup/export?mode=full`) that bundles transactional data in addition to configuration: conversations + messages (with item 47's provenance fields), KB documents + chunks + embeddings, audit logs (with item 46's hash chain intact so partners can re-verify the chain after import), cost logs, evaluation logs, execution traces.
2. **Streaming + paged.** Full exports for established deployments may be gigabytes. The export route streams chunks (NDJSON or a tarball over a streaming response); the admin UI shows progress and the final URL is signed (chains item 16, `upload_to_storage`).
3. **Documented schema.** `.context/orchestration/backup-full-schema.md` describes the exact wire format per entity with version pinning so a partner re-importing into a different deployment knows what to expect.
4. **Restorability test.** A new `npm run smoke:backup-roundtrip` exports a non-trivial environment, imports it into a fresh DB, and asserts row-count and content-hash parity for every entity. Becomes part of the CI suite so backup format changes can't silently break round-tripping.
5. **Selective import.** Import gains the same `mode` parameter (config / full). Existing config-only import path is unchanged.

**Benefits.**

- **Removes vendor-lock-in anxiety at procurement.** Partners commit more readily when the exit door is documented and tested.
- **Pairs with item 29 (GDPR erasure).** The full-export bundle is exactly what a Subject-Access-Request needs, scoped to one user.
- **Pairs with #46 (audit hash chain).** Importing an audit log preserves the chain — the imported deployment can re-verify history.
- **Reuses existing infrastructure.** Backup machinery exists; the gap is scope, not architecture.

**Risks.**

- **Export size.** Multi-gigabyte tarballs are awkward. Mitigation: streaming with progress; partial-export by date range; documented size estimates.
- **Embedding compatibility.** Vector embeddings from one model don't transfer to a deployment using a different embedding model. Mitigation: export records the embedding model + dimension; import warns if the target deployment's model differs; documented re-embedding path on the import side.
- **PII surfaces.** Full export includes conversations, which contain PII. Mitigation: export is admin-only with an explicit "this contains user data" confirmation; signed URLs have short TTLs; access is audit-logged.

**Priority justification.** Lower-tier Tier 8 priority. Less acute than #37–#40 because the current config-only export covers the most common operational need (clone-and-redeploy). But high-leverage for commercial conversations — "we have full data portability" closes a known procurement concern. Build after #46 (audit chain) and #47 (provenance) so the exported data is itself trustworthy.

**Difficulty: Moderate.** Exporter extension + streaming response + admin UI + roundtrip smoke test + documentation. One sprint.

### Tier summary

The thirteen items split into five sub-groups that share an order-of-completion: **correctness → operational visibility → DX → compliance → partner trust**. Each group provides cheap leverage for the next: correctness (#37–#39) makes the dashboards (#40–#41) meaningful; the dashboards make the load tests (#43) interpretable; the load tests give the SDK (#44) defensible baselines; the SDK gives partners the contract; the audit chain (#46) and provenance (#47) give partners the audit trail; WCAG (#48) and portability (#49) close the procurement objections.

Sequenced for shortest path to a partner-defensible foundation: **37 → 40 → 38 → 39 → 48 → 44 → 46 → 47 → 42 → 41 → 43 → 45 → 49**, with #37 (idempotency) first because correctness gaps compound silently, #40 (live engine) second because operational visibility is the first thing partners ask for, #48 (WCAG) early because public-sector procurement is binary, and #44 (OpenAPI/SDK) middle because it multiplies every subsequent iteration. Items #41–#43 and #45–#49 are reorderable based on partner pull.

The unifying property: every Tier 8 item answers "what makes the platform solid enough to build on?" rather than "what new thing does the platform do?" Pre-launch is the moment to spend on these. Retrofitting any of them after partner code is in production is strictly more expensive — and several (per-message version pinning in #47, audit-chain back-fill in #46, idempotency shape in #37) carry a permanent "before vN / after vN" asterisk if deferred.

If the team has 1 sprint: **#37**. If 2–3 sprints: **#37 → #40 → #48**. If 4–6 sprints: **#37 → #40 → #38 → #39 → #48 → #44**. Beyond that, partner-pull and operational pressure dictate the order — the items are independent enough that any individual sprint pays off on its own.

---

## Suggested sequencing

A pragmatic order for the next sprints, optimised for "shortest path to a sellable wedge."

| Sprint | Theme                   | Items                                                                          |
| ------ | ----------------------- | ------------------------------------------------------------------------------ |
| 1      | RAG quality + trust     | ~~1 (hybrid search)~~ ✅, ~~2 (citations)~~ ✅, ~~5 (ingestion)~~ ✅           |
| 2      | Velocity to first pilot | ~~4 (templates)~~ ✅ (narrowed), ~~3 (HTTP fetcher + recipes)~~ ✅             |
| 3      | Validation + polish     | ~~6 (named eval metrics)~~ ✅, ~~7 (widget customisation)~~ ✅                 |
| 4+     | Depth                   | ~~8 (background execution)~~ ✅, ~~9 (tokenisation)~~ ✅, ~~10 (trace UI)~~ ✅ |

Tier 3 items can be picked up opportunistically when a specific pilot needs them.

---

## Cross-references

- `functional-specification.md` — current implemented capabilities
- `business-applications.md` — venture-studio worked examples that drive prioritisation
- `commercial-proposition.md` — buyer-facing positioning
- `maturity-analysis.md` — generic-posture priority tiering and competitive comparison
