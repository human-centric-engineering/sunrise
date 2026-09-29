# Document Clean Up

Interactive preprocessing for knowledge-base documents. Lives at `/admin/orchestration/knowledge/[id]/cleanup`, reached by ticking **Clean up before chunking** on the upload form. Powered by the `cleanup-agent` platform agent and eleven cleanup capabilities.

## When to use

- Raw transcripts (YouTube, meeting recordings, podcasts) with timestamps, speaker labels, and filler words.
- Web-scraped articles with boilerplate (cookie banners, "subscribe" CTAs, navigation breadcrumbs).
- Long-form text where verbose intros, repetition, or trailing footers would dilute chunk-level search.
- Any document where the chunker + embedder will produce noticeably better results from cleaner input.

## When not to use

- CSV uploads — the upload route refuses with `CLEANUP_UNSUPPORTED_FORMAT` because each row is already an atomic chunk.
- Docs that are already clean and well-structured — skip the cleanup checkbox and let them flow straight into chunking.

Book-sized docs (>100k tokens) are supported but degrade in a known way: deterministic capabilities work as normal, whole-doc `rewrite_with_llm` refuses with `document_too_large`, and per-section refines are gated by the section-size guard (see [Refine with agent](#refine-with-agent-from-the-editor)). The UI virtualises the section list so a 200-section doc loads without stalling. If a single section still exceeds the model context window, split it manually before refining or switch to a larger-context model.

## Flow

1. Admin uploads a file with **Clean up before chunking** ticked.
2. Server creates an `AiKnowledgeDocument` with `status='cleaning'`, populates `originalContent`, and creates an `AiConversation` bound to the cleanup agent (`contextType='knowledge_document'`, `contextId=<docId>`).
3. Server sends a confirmation email to the uploader with a deep link to the cleanup page (fire-and-forget; email failure does not abort the session).
4. Browser navigates to `/admin/orchestration/knowledge/<docId>/cleanup`. The cleanup chat opens with the configured starter prompts.
5. Admin and agent converse. Each capability call mutates `processedContent` on the doc row in-place; the preview pane re-fetches and updates after every chat stream event.
6. Admin clicks **Mark cleaned** → finalise endpoint chunks + embeds `processedContent`, sets status to `ready`, and clears both `originalContent` and `processedContent` to reclaim storage.
   - OR **Use original** → same pipeline against the untouched `originalContent`.
   - OR **Discard & delete** → hard-deletes the doc + the cleanup conversation in one transaction.

If the admin navigates away mid-session, the doc stays in `cleaning` status and appears in the **Cleaning** filter on the KB list. The per-row **Continue cleanup** action returns to the chat page where the conversation resumes server-side.

## PDF flow

PDFs go through the existing preview modal first (so coverage warnings are visible) and only land in `cleaning` after the admin confirms the extracted text. The upload writes `metadata.runCleanup: true` onto the preview doc; the confirm endpoint reads it and calls `transitionToCleanup()` instead of `confirmPreview()`.

## Cleanup Agent

| Field                 | Value                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `slug`                | `cleanup-agent`                                                                                                                                                                      |
| `name`                | Document Clean Up Assistant                                                                                                                                                          |
| `visibility`          | `internal`                                                                                                                                                                           |
| `isSystem`            | `true` — a [platform agent](../orchestration/platform-agents.md), defined in `lib/orchestration/agents/platform-agent-definitions/cleanup-agent.ts`; every org gets its own instance |
| Default model         | **Pinned by the reconcile** to the strongest tool-using model the install can reach (see below); empty → resolved at runtime via `agent-resolver.ts`                                 |
| Temperature           | `0.2` — cleanup is procedural, not creative                                                                                                                                          |
| `knowledgeAccessMode` | `restricted` — cleanup never searches the wider KB                                                                                                                                   |

**Why the model is pinned rather than inherited.** Cleanup is a tool-choice
task: fourteen capabilities whose differences are subtle (`collapse_whitespace`
vs `join_wrapped_lines`, `strip_lines_matching` vs `strip_matches`), and a weak
model picks the wrong one and reports success. `pickCleanupBinding()` in the
definition chooses among models that are `toolUse: 'strong'` on a provider the install can
actually reach — active, and with its `apiKeyEnvVar` set or marked local,
mirroring `pickActiveProviderCandidates()` — preferring worker tier over
thinking tier (a whole-document rewrite on a thinking-tier model costs far more
and is no better at picking a regex), then deepest reasoning, then model id for
a stable tie-break. Nothing reachable → both fields stay empty and the runtime
resolver fills them, exactly as before. The pin is applied when the org's
instance is created, and again on any later reconcile while **both** fields are
still empty. An admin's own choice is never overwritten: provider and model
belong to the org.

The system prompt tells the agent to read before it acts and verify after,
states what each tool cannot do, prefers deterministic capabilities, covers the
PDF / transcript / verbose-article / large-document flows, and reminds the
admin to click **Mark cleaned** when satisfied. The prompt is the platform's:
every reconcile writes the definition's prompt back, so an admin's edit to it
in the agent admin UI does not survive the next reconcile.

## Capabilities reference

All fourteen capabilities resolve the active document via the chat session's `contextType` + `contextId`. They error with `not_cleanup_session` if invoked outside a cleanup conversation.

### The agent has to be able to SEE the document

**`read_document` and `find_in_document` are the only capabilities that return
document text.** Everything else reports counts. Without them the agent chooses
transforms blind and cannot tell whether one worked — which is how a real
session ran `strip_lines_matching` with a `\n` pattern (a line-wise tool, so
the pattern could never match), got `success: true, charsRemoved: 0`, and told
the admin the document had been fixed.

Two things close that gap, and both must stay in place:

1. These two read-only capabilities.
2. The `knowledge_document` case in `buildContext`
   (`lib/orchestration/chat/context-builder.ts`), which puts the document's
   name, size and a numbered opening excerpt into the system prompt every turn.
   Before it existed the prompt carried the literal string
   `No context loader for type 'knowledge_document'.` — the agent did not know
   what it was editing. That block is deliberately **not cached**: the document
   changes on almost every turn, so the 60-second context cache would serve a
   stale copy of the thing being edited.

### Deterministic (no LLM cost)

| Slug                    | Args                                                                  | What it does                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strip_lines_matching`  | `{ regex, flags? }`                                                   | Removes whole lines where the regex matches. Returns `invalid_regex` on a malformed or unsafe pattern (see below).                                       |
| `strip_matches`         | `{ regex, flags? }`                                                   | Removes inline regex matches; forces `g` flag. Same `invalid_regex` rejection as `strip_lines_matching`.                                                 |
| `strip_timestamps`      | `{ formats?: ('hh_mm'\|'hh_mm_ss'\|'bracketed'\|'parenthesised')[] }` | Removes timestamp markers in the named formats; default removes all four.                                                                                |
| `strip_speaker_labels`  | `{ format?: 'colon'\|'bracketed'\|'both' }`                           | Removes `Name:` and/or `[Name]` at line start. Multi-word names up to 4 words supported. Non-capitalised speakers not matched.                           |
| `collapse_whitespace`   | `{ keepBlankLines?: boolean }`                                        | Collapses runs of spaces/tabs to one space, trims trailing whitespace, collapses or removes blank lines. Works INSIDE a line — it never joins two lines. |
| `join_wrapped_lines`    | `{ dehyphenate?: boolean, onlyLowercaseContinuations?: boolean }`     | Rejoins sentences a PDF wrapped across lines, and hyphen-split words. The tool for "sentences broken mid-way by a newline".                              |
| `dedupe_lines`          | `{ consecutiveOnly?: boolean }`                                       | Removes duplicate lines (adjacent or doc-wide).                                                                                                          |
| `normalise_punctuation` | none                                                                  | Smart quotes → straight, en/em dashes → `-`/`--`, ellipsis char → `...`, non-breaking space → space.                                                     |
| `preview_diff`          | none                                                                  | Read-only — reports `charsOriginal`, `charsCurrent`, `linesOriginal`, `linesCurrent`, `reductionPct` for the agent to narrate.                           |

**Regex safety.** The cleanup agent picks `regex`/`flags` itself from natural-language instructions, so `strip_lines_matching` and `strip_matches` run every pattern through `compileSafeRegex()` (`lib/orchestration/capabilities/built-in/document-cleanup/context.ts`) before compiling it — a `safe-regex2` check that rejects patterns vulnerable to catastrophic backtracking (e.g. `(a+)+$`) with `invalid_regex`, alongside the existing syntax-error check. Node's `RegExp` engine has no built-in timeout, so this runs _before_ the pattern is ever executed rather than trying to recover from a hang afterward.

### LLM-backed (size-permitting)

**These resolve their binding through `resolveAgentProviderAndModel`, not from
the agent row.** The cleanup agent ships with `provider`/`model` empty so it
inherits the install's configuration; reading the row directly (which all three
LLM paths used to do — both capabilities and `/cleanup/section/refine`) returned
`agent_misconfigured` on every default install, so the LLM half of Document
Clean Up had never worked outside an install that had pinned the agent by hand.

| Slug                       | Args                              | What it does                                                                                                                                      |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rewrite_with_llm`         | `{ instructions }`                | Whole-doc rewrite per natural-language instructions. Refuses with `document_too_large` when the size class is `too-large`.                        |
| `rewrite_section_with_llm` | `{ sectionMarker, instructions }` | Per-section rewrite — finds the section by marker text in a heading or standalone line, sends only that body to the LLM. Works at any total size. |

### Utility

| Slug               | Args                                | What it does                                                                                                                                          |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `estimate_size`    | none                                | Read-only — returns `tokenCount`, `sizeClass` (`small`/`medium`/`large`/`too-large`), and `llmRewriteAllowed`.                                        |
| `read_document`    | `{ fromLine?, lineCount?, which? }` | Read-only — a window of numbered lines from the working text (or the original). Capped at 400 lines / 20,000 chars per call; says when it clamped.    |
| `find_in_document` | `{ regex, flags?, maxMatches? }`    | Read-only — line numbers and text of matching lines. Same `compileSafeRegex` guard; `g`/`y` stripped. Check a pattern here before destroying with it. |

### What the tools cannot do

The agent picked the wrong tool twice in one session because the toolbox's
limits are not obvious from the names. They are stated in the system prompt,
and they are these:

| Tool                   | Does not                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collapse_whitespace`  | join two lines. It works within a line.                                                                                                                                                                                                                             |
| `strip_lines_matching` | match a pattern containing `\n` — it tests each line separately — and it deletes WHOLE lines.                                                                                                                                                                       |
| `strip_matches`        | replace a match with anything. It only deletes, so it cannot turn a newline into a space.                                                                                                                                                                           |
| `join_wrapped_lines`   | resolve a mid-word break with no hyphen (`SurveyMonke` / `y`). Joining with a space and joining without one are both wrong somewhere in the same document, so it reports those line numbers in `suspectedSplitWords` and leaves them for an LLM rewrite or a human. |

## Size class behaviour

Set at upload time by `getDocumentSizeReport()` in `lib/orchestration/knowledge/size-report.ts` and persisted on `metadata.sizeClass`, `metadata.sizeTokens`, `metadata.llmRewriteAllowed`:

| Class       | Token band | Whole-doc LLM rewrite | Notes                                                        |
| ----------- | ---------- | --------------------- | ------------------------------------------------------------ |
| `small`     | ≤ 8,000    | allowed               | Cheap, fast rewrites                                         |
| `medium`    | ≤ 32,000   | allowed               | Affordable but noticeable cost                               |
| `large`     | ≤ 100,000  | allowed               | Expensive; admin should consider per-section rewrites first  |
| `too-large` | > 100,000  | **refused**           | Use deterministic capabilities or `rewrite_section_with_llm` |

The agent reads the class from its session context and self-restricts. The cleanup page header shows a warning callout when `llmRewriteAllowed=false`.

## Storage model

| Field                                                                     | Type      | Lifecycle                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `originalContent`                                                         | `Text?`   | Populated once at upload; never mutated. Cleared on finalise (commit OR use-original) to reclaim storage — after which `GET /documents/:id/download` rebuilds text from the chunk rows instead. |
| `processedContent`                                                        | `Text?`   | Mutated in-place by deterministic + LLM capabilities across the cleanup chat. Cleared on finalise.                                                                                              |
| `metadata.sizeClass`, `metadata.sizeTokens`, `metadata.llmRewriteAllowed` | JSON      | Written at upload time; read by the agent's session prompt and the cleanup page header.                                                                                                         |
| `metadata.runCleanup`                                                     | JSON bool | Written on PDF preview docs to signal that the confirm endpoint should branch into `transitionToCleanup()` instead of `confirmPreview()`.                                                       |
| `metadata.cleanupCommittedMode`                                           | JSON      | Written on finalise — `'commit'` or `'use-original'` so audit / diagnostics can tell which path produced the chunks.                                                                            |

## API surface

| Method | Path                                                                    | Purpose                                                                                                                          |
| ------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/admin/orchestration/knowledge/documents`                       | Existing upload route. Accepts `runCleanup=true` in formData; returns `{ document, redirectTo }` when cleanup is requested.      |
| POST   | `/api/v1/admin/orchestration/knowledge/documents/[id]/confirm`          | Existing PDF preview-confirm route. Reads `metadata.runCleanup`; if set, returns `{ document, redirectTo }` instead of chunking. |
| POST   | `/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/finalise` | New. Body `{ action: 'commit' \| 'use-original' \| 'delete' }`. See route file for behaviour per action.                         |

## Troubleshooting

**The doc is stuck in `cleaning` status.**
The cleanup session is intentionally durable. Filter the KB list to `Cleaning` and click **Continue cleanup** to return to the chat, or open the cleanup page directly via the URL. The session resumes server-side.

**The agent says "not_cleanup_session" mid-conversation.**
This means the doc's status is no longer `cleaning` (probably finalised or deleted in another tab). Refresh the cleanup page; you'll be redirected back to the KB list.

**`rewrite_with_llm` refuses with `document_too_large`.**
The doc is over 100k tokens. Either run deterministic strips first then re-check size with `estimate_size`, or use `rewrite_section_with_llm` on individual sections.

**The cleanup email didn't arrive.**
The send is fire-and-forget — failures log at `warn` level but don't surface in the UI. Check the server logs for "cleanup-ready email failed". The session is still usable from the KB list's **Cleaning** tab regardless.

**My edits to the cleanup agent's prompt were reverted.**
Expected. The cleanup agent is a [platform agent](../orchestration/platform-agents.md): the platform owns what it is — `systemInstructions`, `temperature`, max tokens, knowledge access, the other non-cost fields, and the capability bindings (set to exactly the fourteen declared). Every reconcile (on `npm run db:seed`, on org creation, and from the `platformAgents` maintenance job after a deploy changes the definitions) writes those back, so an edit to any of them does not survive. The admin UI and API still accept the edit today; refusing it is a later task (t-725). What the org owns survives: `provider`, `model`, fallback providers, provider config, monthly budget, per-turn cost cap, rate limit and retention days are set once when the instance is created and never touched again. A fork that needs a different prompt replaces the definition by slug through `registerPlatformAgent()` in `lib/app/platform-agents.ts`.

## Inline editing

In addition to the chat-driven flow, the cleanup page supports **inline human editing** of the document being cleaned. Hover any section, click the pencil, edit the body in a textarea, click Save. The change is committed to `processedContent` and written to the revision history alongside capability mutations.

### Section detection

The doc is broken into editable sections by a layered detector (`lib/orchestration/knowledge/section-detection.ts`). Detectors run in priority order; the first one that finds ≥2 sections wins:

1. **Markdown headings** (`#` through `######`)
2. **Speaker turns** — every change of speaker (`Name:` or `[Name]` at line start) is a boundary; back-to-back turns from the same speaker stay grouped
3. **Title Case lines followed by a blank line** — informal section breaks
4. **Paragraph runs (fallback)** — groups every N paragraphs (default 5); always produces a result

Section ids are content-hashed (FNV-1a of marker + index) so small body edits don't shift ids — the editor can address the same logical section across re-fetches.

Under 50 sections the list renders directly. At or above 50 it virtualises via `react-window` (`components/admin/orchestration/knowledge/section-list.tsx`) so only on-screen rows mount — keeps the DOM bounded and reconciliation fast for book-sized docs. Trade-off: browser Ctrl-F won't match text inside un-rendered sections — scroll the doc to surface them first if you need an in-page find.

### Write serialisation (the row lock)

**Every mutation of `processedContent` goes through `mutateCleanupContent()` in
`lib/orchestration/capabilities/built-in/document-cleanup/context.ts`, which
reads, transforms and writes inside one interactive transaction holding a
Postgres row lock (`SELECT … FOR UPDATE`) on the document.** This is not
optional bookkeeping — it is what makes a multi-step cleanup plan work at all.

The chat tool loop dispatches a turn's tool calls in parallel
(`Promise.allSettled`, `streaming-handler.ts`), so an agent answering "yes,
proceed" to a five-step plan fires five mutating capabilities at once. Without
the lock each one read the same `processedContent` and wrote back its own full
document: last write wins, and four of the five mutations vanished with no
error. The same race broke `writeRevision`'s `max(version)+1` allocation, so
two of the five also failed outright on the `(documentId, version)` unique
index and the agent relayed a raw Postgres error to the admin as "there was an
error processing this step".

Under the lock the five queue and **compose** — each transform sees the
previous one's output. `npm run smoke:cleanup-concurrency` proves it against a
real database: it fires five capabilities concurrently and fails if any
mutation is lost or any revision version collides.

Consequences for anyone adding a cleanup capability:

- Derive new content from the `content` argument `mutateCleanupContent` hands
  your transform — never from a separate read. A capability that reads the
  document itself is back in the race.
- The transform runs inside the transaction: keep it pure and cheap. No network
  calls, no LLM. An LLM rewrite proposes a pending change instead and lands
  through `writeCleanupContent` when the admin accepts it.
- `writeCleanupContent` (used by the edit routes, which already validate
  against a fingerprint) takes the same lock for its write half.

### Edit lock

A cooperative single-writer lock coordinates the agent and the human. It is a
UX-level signal — "another admin is typing" — and is a different mechanism from
the row lock above, which is held for milliseconds and is what actually
serialises writes. While ANY section is being edited:

- The local admin acquires a server-side lock via `POST /cleanup/lock` (5-minute TTL).
- The chat input is disabled with a "Paused: document is being edited" overlay so a capability call can't race the in-progress save.
- Every cleanup capability checks the lock before mutating — inside the row-locked read, via `evaluateLock()` against the columns it has just read; if the lock is held by a different admin, the capability returns `target_locked`. (`requireEditableTarget()` is the same verdict for callers that have not already read the row.)

Lock-held-by-other-admin is surfaced in a banner at the top of the page; the editor and chat are both paused until the holder releases or the TTL expires.

### Conflict resolution

Every section edit POST carries an `expectedFingerprint` — SHA-256 of the section body the editor opened against. On a mismatch (e.g. a capability landed despite the lock), the server returns 409 with the current section body. The UI shows a "Section changed since you started editing" panel with **Keep mine** (re-saves the local draft over the server's update) and **Take theirs** (replaces the textarea content with the server's current body for manual merge).

### Document preview pane

The left half of the cleanup page is a four-tab pane over the same document:

| Tab          | Shows                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cleaned**  | The current `processedContent`, as editable sections (read-only while another admin holds the lock).                                       |
| **Original** | `originalContent` as parsed, never mutated.                                                                                                |
| **Diff**     | Original vs cleaned, the way a file diff reads: line numbers, changed lines highlighted, long unchanged runs collapsed behind an expander. |
| **History**  | Every revision, and a diff of whichever one you select. Same component as the header's History dialog.                                     |

The Diff and History tabs both carry a **unified / split** switch
(`DiffModeToggle`). Split is tight at half width, so the pane header also has an
expand control that spans it across the full grid and drops the chat below —
neither is hidden.

### Revision history

Every mutation — capability call, human edit, restore, finalise — writes a row
to `AiKnowledgeDocumentRevision`. Two entry points render the same
`<RevisionHistory>`: the **History** tab in the preview pane, and the History
button in the page header (a dialog). Revisions are listed newest-first with a
source label (e.g. "Agent: strip_timestamps", "You: section edit", "Finalise:
commit").

Selecting one fetches `GET /cleanup/revisions/:version`, which returns that
revision's content **and** its predecessor's, and diffs the pair — "what did
this step change?". A selector switches the comparison to the current document
— "what would restoring this undo?". The list endpoint deliberately sends
metadata only: every revision row holds the whole document, so content is
fetched one revision at a time.

The predecessor is the highest surviving version below the selected one, not
`version - 1`: retention pruning leaves gaps. When an older revision has no
surviving predecessor the response sets `previousPruned`, and the UI says the
diff is the full revision rather than only what it changed.

Clicking Restore writes a NEW revision with `source: 'restore'` — never
destructive.

**Retention is bounded.** Each revision row stores the document's full content (no diff storage), so an unbounded history scales linearly with edit count × document size. After each write, the revision writer prunes everything beyond the most recent N rows per document. Default N = 50; configurable via `KB_REVISION_RETENTION` env (clamped to `[10, 500]`). When the drawer is at capacity the UI shows a "Showing latest 50 revisions — older entries have been pruned" hint so the cap is visible. The shared constant lives at `lib/orchestration/knowledge/revision-retention.ts` so the server's prune and the client's hint don't drift.

### Diff-card review for LLM rewrites

The two LLM-backed capabilities (`rewrite_with_llm`, `rewrite_section_with_llm`) **do not auto-apply**. They write a row to `AiKnowledgeDocumentPendingChange` and return a `pendingChangeId`. The chat surface intercepts the capability result, opens a side-by-side diff modal, and waits for the admin to Accept or Reject:

- **Accept** → applies `afterContent` to `processedContent`, writes a `capability:<slug>` revision, deletes the pending row.
- **Reject** → just deletes the pending row; doc unchanged, no revision.

The cleanup agent's system prompt knows this contract — it says "I've proposed a rewrite for your review" instead of claiming the rewrite is done.

Deterministic capabilities (`strip_*`, `collapse_whitespace`, `dedupe_lines`, `normalise_punctuation`) keep their auto-apply behaviour — admins don't want to click Accept on a 200-line timestamp strip.

### Sections are addressed by id, never by marker

`POST /cleanup/section` and `POST /cleanup/section/refine` both take a `sectionId` — the id `detectSections` assigns, which hashes the marker _together with the section index_ and is therefore unique within a document. Do not address a section by its `marker`: markers are display labels and repeat routinely (two `## Introduction` headings, a transcript's recurring speaker turns, the `(preamble)` label every doc with leading text gets). Marker lookup resolves to the first match, which means editing the second of two identically-marked sections silently rewrites the first — on the save path the fingerprint check fires against the wrong body, and "Keep mine" then splices over that other section.

The `sectionMarker` field on revision and pending-change rows is a display label only, and is written from the _resolved_ section rather than from the request. The `rewrite_section_with_llm` capability is the deliberate exception: it takes a marker because the agent addresses sections by the text it can see, and it uses its own more-lenient private finder.

### Refine with agent (from the editor)

Inside the section editor, a **Refine with agent** button opens an instructions input. Submitting calls `POST /cleanup/section/refine` which wraps the same LLM-rewrite logic as `rewrite_section_with_llm` but invokable directly from the editor (no chat round-trip). The result emerges as a pending change handled by the same diff modal — unified Accept/Reject UX whether the rewrite came from chat or the editor button.

**Per-section size guard.** Each section shows a token-count badge tinted by ratio to the bound model's context window — amber at ≥80%, red at ≥100% (treating the 4096-token response reserve as part of the budget). When red, the **Refine with agent** button is disabled with a tooltip explaining the limit. The badge estimate is client-side (`chars / 4`); the server-side guard is authoritative. The cleanup page resolves the active agent's context window once at load via `resolveCleanupAgentContextWindow()` (`lib/orchestration/knowledge/cleanup-agent.ts`); when no cleanup conversation exists yet (initial load before any chat), it falls back to 128k.

`POST /cleanup/section/refine` enforces the same budget server-side and returns `413 SECTION_TOO_LARGE` with `{ promptTokens, contextWindow, responseBudget, suggestion }` in `error.details` when the estimated prompt plus the 4096-token response reserve would exceed the model's window. The LLM is not invoked when the guard fires.

### API summary (inline editing)

| Method | Path                                  | Purpose                                                              |
| ------ | ------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/cleanup/lock`                       | Current lock state                                                   |
| POST   | `/cleanup/lock`                       | Acquire / refresh lock (423 LOCK_HELD when another admin owns it)    |
| DELETE | `/cleanup/lock`                       | Release lock                                                         |
| POST   | `/cleanup/content`                    | Whole-document inline edit                                           |
| POST   | `/cleanup/section`                    | Per-section inline edit                                              |
| POST   | `/cleanup/section/refine`             | LLM refine of a section without chat                                 |
| GET    | `/documents/:id/download`             | Download the current text as Markdown (`?variant=cleaned\|original`) |
| GET    | `/cleanup/revisions`                  | List revisions (newest first, paginated) — metadata only             |
| GET    | `/cleanup/revisions/:version`         | One revision's content + its predecessor's, for the history diff     |
| POST   | `/cleanup/revisions/:version/restore` | Restore prior revision (writes a new `source: 'restore'` row)        |
| GET    | `/cleanup/changes/:changeId`          | Read one pending LLM rewrite (what the diff modal loads)             |
| POST   | `/cleanup/changes/:changeId/accept`   | Accept a pending LLM rewrite                                         |
| POST   | `/cleanup/changes/:changeId/reject`   | Reject a pending LLM rewrite                                         |

The diff modal reads its proposal from `GET /cleanup/changes/:changeId`, not
from the per-document `GET /documents/:id`. Every pending row holds a full
before **and** after copy of the document text, and the cleanup view re-fetches
the document route after every chat turn, capability result, section save and
restore — inlining the proposals there would put two extra copies of the
document on each of those responses.

The inline diff itself is bounded: `TextDiffViewer` trims the common prefix and
suffix, then refuses to build its LCS table when more than 1,500 lines still
differ on one side, rendering a "too much changed to diff inline" notice
instead. Unchanged runs longer than the kept context collapse behind an
expander, so a five-line change in a 600-line document is findable without
scrolling. Cleanup targets documents up to ~100k tokens, where an unbounded
`m × n` table hangs or crashes the tab.

## Code map

| Purpose                                                                    | Path                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cleanup page                                                               | `app/admin/orchestration/knowledge/[id]/cleanup/page.tsx`                                                                                                                                                                                                                                      |
| Cleanup view (client)                                                      | `components/admin/orchestration/knowledge/cleanup-view.tsx`                                                                                                                                                                                                                                    |
| Adaptive section list (direct ↔ react-window)                              | `components/admin/orchestration/knowledge/section-list.tsx`                                                                                                                                                                                                                                    |
| Editable section (badge, refine gating)                                    | `components/admin/orchestration/knowledge/editable-section.tsx`                                                                                                                                                                                                                                |
| Finalise endpoint                                                          | `app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/finalise/route.ts`                                                                                                                                                                                                            |
| `createDocumentForCleanup`, `transitionToCleanup`, `commitCleanupAndChunk` | `lib/orchestration/knowledge/document-manager.ts`                                                                                                                                                                                                                                              |
| Size report helper (whole-doc)                                             | `lib/orchestration/knowledge/size-report.ts`                                                                                                                                                                                                                                                   |
| Cleanup-agent context-window resolver                                      | `lib/orchestration/knowledge/cleanup-agent.ts`                                                                                                                                                                                                                                                 |
| Revision retention constant (shared server/client)                         | `lib/orchestration/knowledge/revision-retention.ts`                                                                                                                                                                                                                                            |
| Revision history (list + per-revision diff + restore)                      | `components/admin/orchestration/knowledge/revision-history.tsx`                                                                                                                                                                                                                                |
| Revision history dialog (header entry point)                               | `components/admin/orchestration/knowledge/revision-drawer.tsx`                                                                                                                                                                                                                                 |
| Diff renderer (unified / split, collapsing, line numbers)                  | `components/admin/orchestration/knowledge/text-diff-viewer.tsx`                                                                                                                                                                                                                                |
| Row-locked mutation helper (`mutateCleanupContent`)                        | `lib/orchestration/capabilities/built-in/document-cleanup/context.ts`                                                                                                                                                                                                                          |
| Concurrency smoke script                                                   | `scripts/smoke/cleanup-concurrency.ts`                                                                                                                                                                                                                                                         |
| Revisions writer + prune                                                   | `lib/orchestration/knowledge/revisions.ts`                                                                                                                                                                                                                                                     |
| Confirmation email helper                                                  | `lib/orchestration/knowledge/cleanup-email.ts`                                                                                                                                                                                                                                                 |
| Email template                                                             | `emails/cleanup-ready.tsx`                                                                                                                                                                                                                                                                     |
| Cleanup capabilities                                                       | `lib/orchestration/capabilities/built-in/document-cleanup/*.ts`                                                                                                                                                                                                                                |
| Agent definition + capability seed                                         | `lib/orchestration/agents/platform-agent-definitions/cleanup-agent.ts`, `prisma/seeds/019-cleanup-capabilities.ts`                                                                                                                                                                             |
| Tests                                                                      | `tests/unit/lib/orchestration/capabilities/built-in/document-cleanup/`, `tests/unit/lib/orchestration/knowledge/`, `tests/unit/components/admin/orchestration/knowledge/cleanup-view.test.tsx`, `tests/integration/api/v1/admin/orchestration/knowledge.documents.id.cleanup.finalise.test.ts` |
