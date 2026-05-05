# Orchestration Improvement Priorities

Prioritised improvements to the orchestration layer, scoped to the deployment profile Sunrise actually targets: **single-tenant, one instance per project, small engineering teams, small projects.**

**Last updated:** 2026-05-05 (item 10 shipped)

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
- **Aggregates card (Phase 3).** `ExecutionAggregates` renders total wall, p50/p95 step duration (nearest-rank), slowest step (label + duration), LLM share (sum of `llmDurationMs` / total wall), and a per-step-type breakdown (count · duration · tokens). Hidden when the trace has fewer than 2 entries — single-step traces have no aggregate to summarise.
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
- **Aggregate `totalWallMs` does not collapse parallel branches.** It sums all step durations, so parallel branches inflate the number above the actual wall-clock duration of the run. For single-tenant deployments parallel branches are uncommon, and when they happen, the timeline strip's bar layout is the more honest visualisation. Documented in the helper's JSDoc.

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
