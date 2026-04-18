---
allowed-tools: Bash, Glob, Grep, Read, Agent
description: Fast-path fix executor — two modes, review (applies /test-review findings) or from-rescan (applies /test-triage ledger NOTES). No intermediate plan file.
---

Fast-path executor for quality-fix passes. Spawns a single test-engineer subagent to apply test fixes without the `/test-plan review` + `/test-write plan` overhead.

Two input modes:

- **Review mode (default)** — reads `.claude/tmp/test-review.md` and applies the Rewrite/Add/Delete prescriptions. Use after `/test-review`. Best for branch BAU work where you already have a full audit.
- **Rescan mode (`from-rescan`)** — reads the file's row from `.claude/testing/remediation-ledger.md` and applies the Sonnet NOTES directly. Use after `/test-triage rescan` when you want to patch specific findings without running a full review. Best for ledger-driven remediation on files graded Minor or Bad with specific, actionable NOTES.

For scopes larger than 5 files, or coverage-driven work, use `/test-plan review` + `/test-write plan` regardless of mode.

## Input

$ARGUMENTS — mode auto-detects from the first token:

- **`from-rescan <test-file>`** → rescan mode (see "Mode: from-rescan" below).
- **No arguments, or scope path** (e.g. `components/analytics`, `lib/auth/foo.ts`) → review mode (see "Mode: review (default)" below).

## Mode: review (default)

### Step 1: Read the review file

- Read `.claude/tmp/test-review.md` and follow the reader protocol in `.claude/docs/test-command-file-protocol.md`:
  1. Parse the frontmatter metadata.
  2. Hard-stop if the invocation scope argument disagrees with the review's scope (e.g. reviewing `lib/auth` but user typed `/test-fix components/analytics`). If the user's arg is a strict subset of the review's scope, that's fine — filter the review entries (Step 2).
  3. Soft-warn on age >1h. Hard-pause on age >24h OR branch/HEAD change — these risk applying stale prescriptions to shifted source.
  4. Print the provenance line.
- If the file does not exist, report: "No review found at `.claude/tmp/test-review.md`. Run `/test-review` first." and stop.

### Step 2: Filter and count files

Parse the review's `## Structured Findings` section. Each `### {source} → {test}` block is one file.

- If a scope arg was passed, keep only blocks whose `source file path` matches (folder match → any file under the folder; file match → exact match).
- If 0 files remain, report: "Review contains no entries matching `{arg}`. Run `/test-review {arg}` first." and stop.
- **If 6+ files remain**, refuse with:

  > This fast path is sized for 1–5 files. For {N} files, use the structured flow:
  >
  > ```
  > /test-plan review → produces phased plan with batching
  > /test-write plan  → executes with parallel agents
  > ```
  >
  > `/test-fix` is designed around a single subagent spawn; 6+ files exceeds what one agent should own in one session.

  Stop.

### Step 3: Enforce Source Findings (hard stop on pending)

Inspect the review's `## Source Findings` section.

- If absent or empty, continue.
- For every finding, check `**Status**`. Valid terminal values: `resolved` or `accepted`. Any `pending` → STOP with the same message `/test-plan review` uses:

  > `{count}` source finding{s} in `.claude/tmp/test-review.md` {is/are} still `pending`. `/test-fix` refuses to run until every finding is `resolved` or `accepted`. Return to the review conversation to resolve them (say "fix them", "document {finding}", or "skip {finding}").

  Do not offer to patch statuses — that's the user's explicit authorization, handled in the review conversation.

- If every finding is terminal, print one-line confirmation: `Source findings: {R} resolved, {A} accepted — OK to proceed.`

### Step 4: Plan-time source sanity check

This is the step that catches planning errors before they become agent thrash. Runs in the main agent, inline.

For each **Rewrite** item in the filtered scope whose `Should:` line prescribes a specific call count (`toHaveBeenCalledTimes(N)`) OR a specific call signature (`toHaveBeenCalledWith({...})`):

1. Identify the source file and the approximate function/effect being exercised by the linked test.
2. Read the relevant source range (narrow — just the function body or effect closure, not the whole file).
3. Check for structural elements that could invalidate the prescribed assertion:
   - **One-shot `useRef` guards** (e.g. `if (someRef.current) return`) that block re-runs on the same instance.
   - **Early returns** that skip the call path being asserted.
   - **Conditional effects** (e.g. `useEffect(() => {...}, [dep])` where `dep` determines whether the call happens at all).
   - **Async ordering** — the prescribed count may assume a synchronous path that's actually gated on a promise.
4. If anything looks suspicious, add the item to a `Sanity-check flags` list with a one-line note. If everything checks out, silently pass.

Rules:

- Read only the source files you need. Do NOT pre-read everything "just in case" — the sanity check is per-item, not per-file.
- A flag is not a block. The user sees the flag in Step 5 and decides whether to adjust the prescription or confirm.
- False positives are fine (user reads the note and says "that's actually correct"); false negatives are the cost we're trying to avoid.

### Step 5: Present execution summary and confirm

Show the user:

```
## /test-fix — {N} files from {review scope}

**Review**: `.claude/tmp/test-review.md` ({age}, branch {branch}, HEAD {head-short})
**Source findings**: {R} resolved, {A} accepted (0 pending — verified in Step 3)

| File | Test File | Keep | Rewrite | Add | Delete |
|------|-----------|------|---------|-----|--------|
| `components/x.tsx` | `tests/unit/components/x.test.tsx` | 6 | 2 | 1 | 2 |

### Sanity-check flags ({count})
{Only shown if Step 4 flagged anything. Else "None — all prescriptions look valid against current source."}

- `{file}:{line}` — `{test name}`
  - Prescription: {Should: line from review}
  - Concern: {one-line note about the guard / early return / conditional you spotted}

Proceed? (Y/n — reply "adjust" to modify a prescription before spawning)
```

If the user replies "adjust", list the flagged items as options and ask which prescription they want to change and to what. Apply the change to the in-memory view (do NOT rewrite the review file — the review is the permanent record; the change is a one-off override for this execution). Then re-show the summary and ask again.

### Step 6: Spawn a single test-engineer subagent

Spawn ONE foreground test-engineer agent. The prompt is self-contained — the agent does not need to read the review file or the plan file.

The prompt must include:

1. **Identity and trimmed required reading:**

   > You are executing a `/test-fix` quality pass — small scope, no plan file intermediate. Read these two docs before writing any tests:
   >
   > 1. `.context/testing/patterns.md` — AAA structure, shared mocks, type-safe assertions
   > 2. `.context/testing/mocking.md` — dependency mocking strategies
   >
   > Skip the full onboarding reading list (overview/gotchas/SKILL/brittle-patterns) — the brittle patterns are embedded below, and the other docs are only needed for fresh-test bootstrapping which this is not.

2. **Brittle patterns inline** (copy the 6-bullet list from `.claude/docs/test-brittle-patterns.md`):

   > Before writing or rewriting any test, check against these known anti-patterns:
   >
   > - Multi-render `toHaveBeenNthCalledWith` in one `it` block → split into separate blocks.
   > - `.not.toThrow()` on empty arrow functions → assert observable post-error state.
   > - Mid-test `vi.clearAllMocks()` before `not.toHaveBeenCalled()` → use explicit `toHaveBeenCalledTimes(N)` before and after.
   > - Dead `vi.mock(...)` blocks → delete them.
   > - `.toBeDefined()` after `.find()` → assert specific elements.
   > - Add/Rewrite overlap → merge if an Add duplicates what a Rewrite already asserts.

3. **Per-file work instructions** — for each file in scope, include the review's Keep/Rewrite/Add/Delete entries verbatim (with line numbers). If the user adjusted a prescription in Step 5, use the adjusted version.

4. **Any sanity-check flags** — include as guidance: "Note: the sanity check flagged `{file}:{line}`'s prescription for {concern}. If you hit this, re-read the source, follow brittle pattern #N or the gotchas doc, and revise the assertion to match the honest contract (that's a plan error, not a source bug)."

5. **Test quality requirements** — AAA, test intent not output, use shared mocks/assertions, one behaviour per test.

6. **Mid-sprint source-bug protocol** — identical to `/test-write` (stop, report under `## New Source Findings`, park with `it.todo`, continue to next file).

7. **Validation** — `npm test -- {test paths}`, `npm run lint`, `npm run type-check` must all pass.

8. **Output format**:

   ```
   ### File: {test path}
   - Kept: {N}
   - Rewritten: {N} — list names
   - Added: {N} — list names
   - Deleted: {N} — list
   - Pass: {N}/{N}
   - Lint/type-check: clean

   ### Deviations from the prescriptions
   {Anything done differently and why. If none, say "None".}

   ### New Source Findings
   {If any; else "None".}
   ```

### Step 7: Report results

After the agent returns, print a compact summary:

```
## /test-fix Complete: {review scope}

**Files processed**: {count}
**Totals**: {rewritten} rewritten, {added} added, {deleted} deleted, {kept} kept
**Pass**: {total passing}/{total tests} (parked `it.todo` count as known gaps)
**Lint/type-check**: clean | {N} errors (list)

### Deviations from prescriptions
{Agent's deviations block. If none, "None".}

### New Source Findings
{Agent's findings block. If none, "None — fix honored the plan."}
```

### Step 8: Capture-gotcha hook

If the agent's output contained a non-empty `Deviations from the prescriptions` section OR a non-empty `New Source Findings` section, emit:

> Any of these worth adding to `.claude/skills/testing/gotchas.md`? Reply "capture {short phrase}" to log one as a gotcha entry. Reply "skip" to continue.

If the user replies with a capture request:

1. Read `.claude/skills/testing/gotchas.md`.
2. Append a new numbered entry at the end of the "Critical Gotchas" section, following the existing format (Problem / Solution / code example / Status line citing the discovery context).
3. Confirm to the user: `Captured gotcha #{N} in .claude/skills/testing/gotchas.md — future agents will pick it up.`

If the user replies "skip" or with anything else, continue without capturing.

### Step 9: Offer next steps

The `/test-fix` validation chain (lint + type-check + tests passing) IS the convergence signal. Do **not** propose `/test-review` as the default next step — that's the loop trap that costs the user tokens for diminishing returns. Reserve re-audit for explicit triggers (source changed since the original review, user asks, or `/pre-pr` flagged something net-new).

Branch on what actually happened in this run:

#### If validation passed and the agent had no Deviations and no New Source Findings

```
Production-ready for `{scope}`. Next: `/pre-pr` for final validation, then ship.
```

#### If validation passed but the agent had Deviations or New Source Findings

```
Fixes applied. The agent flagged {N} deviation(s) / {M} new source finding(s) — review the report above before shipping.

Next options:
- Address the deviations or new findings (inline, or open a fresh `/test-review {scope}` only if they suggest the prescriptions need rethinking).
- `/pre-pr` — proceeds with current state if you accept the deviations.
```

#### If validation failed (lint, type-check, or tests broke)

```
{N} validation failure(s) — see the report above. The fixes are NOT production-ready.

Next: address the failures (the agent's report names the specific tests/files), then re-run `/test-fix {scope}` or move to `/pre-pr` once clean.
```

In all cases: do not auto-suggest `/test-review` for "another pass". Catalog items recorded in the original review remain catalog — they don't become Improve items just because tests changed.

---

## Mode: from-rescan

Rescan-driven fast path. Skips the full `/test-review` audit and patches directly against the ledger's Sonnet NOTES. The assumption is that you've just run `/test-triage rescan <file>`, you've read the NOTES, and you want to act on them.

Expect variance similar to the review path — neither guarantees convergence in one shot. The payoff is lower token cost and less ceremony for Minor/Bad files with tractable findings.

### Step 1: Parse and validate args

Expect exactly `from-rescan <test-file>`. Hard-stop if the file argument is missing or doesn't exist. Hard-stop if it doesn't look like a test file (`tests/**/*.test.{ts,tsx}`).

### Step 2: Read the ledger row

- Open `.claude/testing/remediation-ledger.md`. Hard-stop if absent: "No ledger found — run `/test-triage scan <folder>` or `/test-triage rescan {file}` first."
- Find the row keyed by the test file. Hard-stop if absent: "No ledger row for `{file}` — run `/test-triage rescan {file}` first."
- Parse `grade`, `sig_hits`, `block_patterns`, `test_count`, `last_head`, `last_scanned`, `notes`.
- If `grade == Clean`, stop with: "`{file}` is already Clean — nothing to fix. If you suspect this is stale, run `/test-triage rescan {file}` or escalate to `/test-review {file}`."

### Step 3: Staleness check

- Resolve the source path from the test path using project conventions (mirror of `tests/unit/` into source tree).
- `git log -1 --format=%H -- <source>` for the source's current HEAD.
- If the current source HEAD differs from the row's `last_head`, pause:
  > Ledger row for `{file}` was written at source HEAD `{last_head-short}`, but source is now at `{current-short}`. The NOTES may target drifted code. Run `/test-triage rescan {file}` first? (Y/n)
- If the user says Y (or anything other than an explicit "no, proceed"), stop. If they confirm proceed, continue.

### Step 4: Present summary and confirm

```
## /test-fix from-rescan — {file}

**Source**: `{source}`
**Grade**: {grade} · {sig_hits} sigs · block: {block_summary}
**Last scanned**: {last_scanned} at HEAD {last_head-short}
**NOTES**: {notes}

The test-engineer will read both files and apply the NOTES above as prescriptions. This is NOT a full audit — no per-test Keep/Rewrite/Add/Delete breakdown. The agent patches what the NOTES name and leaves everything else alone.

Proceed? (Y/n)
```

If the user says n, stop.

### Step 5: Spawn a single test-engineer subagent

Spawn ONE foreground test-engineer. The prompt includes:

1. **Identity and trimmed reading list** (same two docs as review mode: `.context/testing/patterns.md` and `.context/testing/mocking.md`; skip the rest).

2. **Brittle patterns inline** (same 6-bullet list from review mode).

3. **Scope**:
   - Test file: `{test path}`
   - Source file: `{source path}`
   - Current grade: `{grade}` — block breakdown `{block_summary}`, signature hits `{sig_hits}`
   - Ledger NOTES: `{notes}` (verbatim — this is your primary prescription)

4. **Task**:

   > Read both files. The NOTES above come from a narrow Sonnet triage pass — they name specific quality gaps but do not provide per-test prescriptions. Translate each NOTE into the minimum edit that addresses it:
   >
   > - Untested code path ("X throws Y", "source has branch Z no test covers") → add one focused `it()` block covering it. Use existing test scaffolding — don't invent new mock infrastructure.
   > - Test/code mismatch ("title says A, assertion tests B") → rename the test OR restructure its assertion to match its name, whichever is closer to the source's actual contract.
   > - Mock-proving ("N tests pass even if code under test is deleted") → rewrite the flagged assertion(s) against a real observable contract (return value shape, side-effect, state change).
   > - Missing-error ("source defines error E, no test covers it") → add the error-path test.
   >
   > Scope discipline: only address what the NOTES call out. Do NOT rewrite unrelated tests. Do NOT re-audit the file looking for extras. If a note is ambiguous (multiple valid interpretations, or you can't locate the referenced code), record it under "Ambiguous notes" and leave the test alone — don't guess.

5. **Test quality requirements** (same as review mode: AAA, test intent not output, shared mocks/assertions, one behaviour per test).

6. **Mid-sprint source-bug protocol** (same as review mode: stop, report under "New Source Findings", park with `it.todo`, continue).

7. **Validation**: `npm test -- {test path}`, `npm run lint`, `npm run type-check` must all pass.

8. **Output format**:

   ```
   ### Patches applied
   - {one line per change, keyed to the NOTE it addresses}

   ### Tests: {N}/{N} pass · Lint/type-check: clean | {errors}

   ### Ambiguous notes
   {Notes we couldn't act on, with reason. If none, "None".}

   ### New Source Findings
   {If any; else "None".}
   ```

### Step 6: Report results

```
## /test-fix from-rescan Complete: {file}

**Patches**: {count}
**Pass**: {pass}/{total}
**Lint/type-check**: clean | {errors}

### Patches applied
{agent output, verbatim}

### Ambiguous notes
{agent output or "None"}

### New Source Findings
{agent output or "None"}
```

### Step 7: Capture-gotcha hook

Same as review mode: if the agent's output has non-empty "Ambiguous notes" OR "New Source Findings", offer `gotchas.md` capture.

### Step 8: Offer next steps

Branch on outcome — do NOT default to suggesting `/test-review`. That's the loop trap. The `/test-triage rescan` update IS the convergence signal here.

#### Validation passed, no ambiguity, no new source findings

```
Patches applied. Next: `/test-triage rescan {file}` to update the ledger and see the new grade.

Expect variance — Sonnet may surface net-new findings on the next rescan even if this patch landed cleanly. That's narrow-audit variance, not a regression. If the grade moved in the direction you wanted, you're done — stop here or continue based on how much the remaining findings matter.
```

#### Validation passed, ambiguous notes or new source findings

```
Patches applied with {N} ambiguous note(s) / {M} new source finding(s). The agent left ambiguous cases untouched.

Next options:
- `/test-triage rescan {file}` — see the new grade as-is (ambiguous cases remain in the ledger).
- `/test-review {file}` — if the ambiguity suggests audit-level inspection would actually help. Don't reach for this reflexively; it's a token cost, not a safety net.
```

#### Validation failed

```
{N} validation failure(s) — see the report above. The patches are NOT production-ready.

Next: address the failures, then re-run `/test-fix from-rescan {file}` or escalate to `/test-review {file}` if the failures suggest the NOTES were wrong.
```

---

## What this command does NOT do

- **No plan file written** — in review mode the review file remains the authoritative record; in rescan mode the ledger row is the authoritative record. If you need a persistent plan artefact (for review, handoff, or re-run), use `/test-plan review`.
- **No multi-sprint batching** — single agent spawn, single file (rescan mode) or all review-file entries (review mode). For 6+ files or mixed-complexity scopes, the plan + write path is better.
- **No source-file edits beyond what the test-engineer agent itself does** — in review mode, source fixes for Source Findings happen upstream in the review conversation. In rescan mode, there's no Source Findings surface at all; source bugs surfaced mid-fix are reported under "New Source Findings" and parked with `it.todo`.
- **No re-audit** — neither mode re-scans the file after patching. Update the ledger with `/test-triage rescan {file}` to see the new grade. Neither mode guarantees convergence in one pass; both exhibit narrow-audit variance.
