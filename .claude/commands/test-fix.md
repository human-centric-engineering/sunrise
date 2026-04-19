---
allowed-tools: Bash, Glob, Grep, Read, Agent
description: Apply findings from a /test-review report (or /test-triage ledger NOTES). Two modes: review (default) or from-rescan.
---

Fast-path executor for quality-fix passes. Reads a confidence-scored `/test-review` report (or a `/test-triage` ledger row) and spawns a single test-engineer subagent to apply the findings.

Two input modes:

- **Review mode (default)** — reads the latest (or named) report at `.reviews/tests-{slug}.md` produced by `/test-review`. User picks which findings to action (`--all` or `--findings=1,3,5`). Source findings surface first with explicit per-finding confirmation before any refactor lands.
- **Rescan mode (`from-rescan`)** — reads the file's row from `.claude/testing/remediation-ledger.md` and applies the Sonnet NOTES directly. Use after `/test-triage rescan` when you want to patch specific findings without running a full review. Best for ledger-driven remediation on files graded Minor or Bad with specific, actionable NOTES.

## Input

$ARGUMENTS — mode auto-detects from the first token:

- **`from-rescan <test-file>`** → rescan mode (see "Mode: from-rescan" below).
- **Anything else** → review mode. Accepts:
  - `/test-fix` — use the most recently written `.reviews/tests-*.md`
  - `/test-fix <scope-path>` — resolve the scope path to `.reviews/tests-{slug}.md` (e.g. `lib/auth` → `tests-lib-auth.md`)
  - `/test-fix <slug>` — use `.reviews/tests-{slug}.md` directly
  - Any of the above may be combined with `--all` or `--findings=1,3,5` to skip the picker.

## Mode: review (default)

### Step 1: Locate the review file

Resolve in this order:

1. **Explicit slug or scope arg** — if the first non-flag arg is a path, compute slug: replace `/` with `-`, drop leading `tests-` if present. Look for `.reviews/tests-{slug}.md`.
2. **No arg** — list `.reviews/tests-*.md` by mtime descending; pick the most recent.

If nothing is found, report: "No review found. Run `/test-review [scope]` first — it writes to `.reviews/tests-{slug}.md`." and stop.

If the user passed a scope arg that maps to a non-existent report, report which file was expected (`.reviews/tests-{computed-slug}.md`) so they can either run `/test-review {arg}` or name a different slug.

### Step 2: Parse the report

Read the full report. Extract:

- **Frontmatter** (if present — the v2 review template writes it as an HTML comment header, plain text, or embedded in the first few lines):
  - `Reviewed` timestamp
  - `Branch` and `HEAD`
  - `File pairs reviewed`
  - `Findings ≥80` count
- **Critical Findings (90–100)** — numbered list; each entry has File, Source, Category, Confidence, Issue, Evidence, Suggested fix.
- **Important Findings (80–89)** — same structure.
- **Source Findings** — numbered list with File, Line, Confidence, Issue, Evidence, Suggested refactor, Blast radius.
- **Orphan Tests** (if any) — skip; not fixable without source context.

Assign a global 1-based index to findings in the order they appear: Critical first, then Important. Source findings get their own `S1, S2, …` numbering.

Build a dependency map: if a finding's `Suggested fix` line mentions "Source Finding N" or "Depends on Source Finding N", record that the finding depends on `S{N}`.

### Step 3: Staleness check

Compute `age = now - reviewed_at`.

- **Age ≤ 1h** — silent, print provenance line.
- **Age > 1h, ≤ 24h, same branch and HEAD** — print a soft warning: `Review is {age} old but branch/HEAD unchanged. Continuing.`
- **Age > 24h OR branch/HEAD differs from current** — hard pause:
  > Review at `{path}` was generated on branch `{branch}` at HEAD `{head-short}` ({age} ago). Current branch is `{current-branch}` at HEAD `{current-head-short}`. Prescriptions may be stale. Re-run `/test-review {scope}` first? (Y/n to continue anyway)

If the user says anything other than explicit continue, stop.

Print a one-line provenance block:

```
Review: `.reviews/tests-{slug}.md` — {age} old · branch {branch} · HEAD {head-short}
```

### Step 4: Pick findings

Apply filters in this order:

1. **`--findings=N,N,N`** — keep only the listed 1-based indices. Validate each index exists; hard-stop with `Finding {N} not found — report has {max} findings numbered 1..{max}`.
2. **`--all`** — keep every finding (Critical + Important).
3. **No flag** — print the picker:

   ```
   ## /test-fix — pick findings from `.reviews/tests-{slug}.md`

   **Critical (90–100)**
   1. ({conf}) `{file}:{line}` — {one-line issue}
   2. ({conf}) `{file}:{line}` — {one-line issue}
   ...

   **Important (80–89)**
   3. ({conf}) `{file}:{line}` — {one-line issue}
   ...

   **Source Findings** (referenced by one or more test findings)
   S1. ({conf}) `{file}:{line}` — {one-line issue} · {blast radius}
   ...

   Which findings should I apply? Reply with:
   - `all` — every Critical + Important finding above
   - `critical` — only Critical (90–100)
   - `1,3,5` — specific indices
   - `none` — stop here

   Source findings are handled separately in the next step (one confirm each).
   ```

   Wait for the user's reply. `none` stops. Otherwise resolve to an index list.

### Step 5: Source finding gate

Compute the set of source findings referenced (directly or transitively) by the picked test findings.

If the set is empty, print `No source findings required — proceeding to test fixes.` and skip to Step 6.

For each referenced source finding, present:

```
### Source Finding S{N} — `{file}:{line}` (confidence {conf})

**Issue:** {issue paragraph from the report}

**Evidence:** {evidence paragraph}

**Suggested refactor:**
{refactor snippet or description}

**Blast radius:** {blast radius line}

**Depended on by:** findings {list of test finding indices}

Apply this refactor before the test fixes? (y/n/defer)
- `y` — the test-engineer will apply the source refactor first, then fix the dependent tests.
- `n` — decline the source refactor. Dependent test findings ({list}) will be dropped from this run.
- `defer` — leave the source untouched AND leave the dependent test findings for a later pass. Same net effect as `n` but records "deferred" in the run summary so you know to come back.
```

Wait for reply per finding. Collect decisions:

- **`y`** — source refactor is queued. Its dependent test findings remain in the selection.
- **`n`** or **`defer`** — drop the source refactor AND every dependent test finding from the selection. Print one line: `Dropped findings {list} — depended on source S{N} which was {declined/deferred}.`

If every picked finding got dropped (user declined all source findings they depended on), stop with:

> Every picked finding depends on a source finding you declined or deferred. Nothing to do — come back when you're ready to accept the source changes, or run `/test-review` again after a manual source fix.

### Step 6: Plan-time source sanity check

For each remaining test finding whose `Suggested fix` prescribes a specific call count or call signature:

1. Read the relevant source range (narrow — function body or effect closure).
2. Check for structural elements that could invalidate the prescribed assertion:
   - One-shot `useRef` guards
   - Early returns that skip the call path
   - Conditional effects where a dep gates the call
   - Async ordering assumptions that conflict with a synchronous prescription
3. If anything looks suspicious, record it as a `Sanity-check flag` with a one-line note. Otherwise silently pass.

A flag is guidance, not a block. User sees it in Step 7 and decides whether to adjust or proceed.

Skip this step for findings whose `Suggested fix` is "needs judgement" or a general refactor description — the sanity check targets mechanical prescriptions.

### Step 7: Present execution summary and confirm

```
## /test-fix — {N} findings from `.reviews/tests-{slug}.md`

**Scope**: {scope description}
**Source refactors queued**: {count}
  - S{N}: `{file}:{line}` — {one-line refactor}
**Test findings queued**: {count}
  - {index}. `{file}:{line}` — {one-line}
{repeat, grouped by test file for readability}

**Dropped** (source dependency declined/deferred): {count}
  - {index}. `{file}:{line}` — depended on S{N} ({declined|deferred})

### Sanity-check flags ({count})
{Only shown if Step 6 flagged anything. Else omit this section.}

- Finding {index} — `{file}:{line}`
  - Prescription: {suggested fix}
  - Concern: {one-line note}

Proceed? (Y/n — reply `adjust {index} <new instruction>` to override a single prescription)
```

If the user says `adjust {index} <text>`, record the override (in-memory only — do NOT rewrite the report) and re-show the summary. The agent prompt will use the override in place of the original `Suggested fix` for that finding.

### Step 8: Spawn a single test-engineer subagent

Spawn ONE foreground test-engineer. The prompt is self-contained — the agent does not need to open the report.

The prompt must include:

1. **Identity and trimmed reading list:**

   > You are executing a `/test-fix` quality pass — applying specific findings from a confidence-scored review. Read these two docs before writing any tests:
   >
   > 1. `.context/testing/patterns.md` — AAA structure, shared mocks, type-safe assertions
   > 2. `.context/testing/mocking.md` — dependency mocking strategies
   >
   > Skip the full onboarding reading list — the brittle patterns are embedded below.

2. **Brittle patterns inline** (copy the 6-bullet list from `.claude/docs/test-brittle-patterns.md`):

   > Before writing or rewriting any test, check against these known anti-patterns:
   >
   > - Multi-render `toHaveBeenNthCalledWith` in one `it` block → split into separate blocks.
   > - `.not.toThrow()` on empty arrow functions → assert observable post-error state.
   > - Mid-test `vi.clearAllMocks()` before `not.toHaveBeenCalled()` → use explicit `toHaveBeenCalledTimes(N)` before and after.
   > - Dead `vi.mock(...)` blocks → delete them.
   > - `.toBeDefined()` after `.find()` → assert specific elements.
   > - If a finding's fix overlaps with another, merge the edit — don't add duplicate tests.

3. **Source refactors to apply first** (if any from Step 5):

   > Apply these source refactors BEFORE touching any tests. Each is a pre-approved named extraction / simple restructure. After all refactors land, run `npm run type-check` once to verify the source compiles; then move on to the test findings.
   >
   > - **S{N}**: `{source file}:{line}` — {issue}
   >   - Refactor: {suggested refactor, verbatim from the report including any code snippet}
   >   - Blast radius: {line}

4. **Test findings to apply** (deduplicated by file when useful — keep the per-finding structure visible to the agent):

   > For each finding below, edit the named test file at the named line range. The `Suggested fix` is the target state; translate it to concrete code using the project's testing patterns.
   >
   > - **Finding {index}** ({category}, confidence {conf}) — `{test file}:{line}`
   >   - Source: `{source file}`
   >   - Issue: {issue}
   >   - Evidence: {evidence}
   >   - Suggested fix: {suggested fix, or user's override from Step 7}
   >     {If this finding depended on a source refactor:} Depends on S{N} (already applied above).

5. **Sanity-check flags as guidance** (if any from Step 6):

   > The planner flagged these prescriptions as potentially incompatible with current source — if you hit a wall on one, re-read the narrow source range, follow the brittle-pattern list above, and revise the assertion to match the honest contract. That's a plan error, not a source bug. Flags:
   >
   > - Finding {index}: {concern}

6. **Test quality requirements** — AAA, test intent not output, use shared mocks/assertions, one behaviour per test.

7. **Mid-run source-bug protocol** (same as `/test-write`):

   > If you discover a source bug that isn't one of the queued source refactors, STOP editing that file. Report it under `## New Source Findings` in your output with file:line and a one-paragraph description. Park any affected test with `it.todo('<short description>')` and continue with the next finding. Do NOT fix source bugs mid-run.

8. **Validation**:

   > After all edits, run:
   >
   > - `npm test -- {affected test paths}`
   > - `npm run lint`
   > - `npm run type-check`
   > - `npm run format:check` (if it fails, run `npx prettier --write {edited paths}` and re-verify — matches what lint-staged does on commit, so running it here prevents pre-pr format failures)
   >
   > All four must pass. If a validation step fails, fix the test or parked `it.todo` that triggered it; do not paper over the failure.

9. **Output format**:

   ```
   ### Source refactors applied
   - S{N}: {one-line summary}
   {or "None."}

   ### Findings applied
   - Finding {index} ({category}) — `{test file}:{line}` — {one-line result: "rewritten", "new test added", "assertion tightened", etc.}
   ...

   ### Tests: {pass}/{total} · Lint: clean|{errors} · Type-check: clean|{errors} · Format: clean|{errors}

   ### Deviations from the suggested fixes
   {Anything done differently and why. If none, "None".}

   ### New Source Findings
   {Any source bugs discovered mid-run; else "None".}
   ```

### Step 9: Report results

```
## /test-fix Complete — {slug}

**Report**: `.reviews/tests-{slug}.md`
**Findings applied**: {count} ({critical} critical, {important} important)
**Source refactors applied**: {count} ({list of S-ids})
**Findings dropped**: {count} (source dependency declined/deferred)
**Tests**: {pass}/{total} · Lint: {status} · Type-check: {status} · Format: {status}

### Applied
{agent output: findings list, verbatim}

### Deviations
{agent output, verbatim — or "None"}

### New Source Findings
{agent output, verbatim — or "None"}
```

### Step 10: Capture-gotcha hook

If the agent's output contained a non-empty `Deviations` OR `New Source Findings` section, emit:

> Any of these worth adding to `.claude/skills/testing/gotchas.md`? Reply `capture {short phrase}` to log one as a gotcha entry. Reply `skip` to continue.

If the user replies with a capture request:

1. Read `.claude/skills/testing/gotchas.md`.
2. Append a new numbered entry at the end of the "Critical Gotchas" section, following the existing format (Problem / Solution / code example / Status line citing the discovery context).
3. Confirm: `Captured gotcha #{N} in .claude/skills/testing/gotchas.md — future agents will pick it up.`

If the user replies `skip` or anything else, continue without capturing.

### Step 11: Offer next steps

The validation chain (lint + type-check + tests) IS the convergence signal. Do NOT auto-suggest `/test-review` for "another pass" — the report's below-threshold findings are intentionally filtered; re-running to surface them is the loop trap.

Branch on outcome:

#### Validation passed, no deviations, no new source findings

```
Applied {N} findings cleanly. Next: `/pre-pr` for final validation, then ship.

Deferred or declined source findings remain in `.reviews/tests-{slug}.md` — re-run `/test-fix {slug} --findings={indices}` if you change your mind.
```

#### Validation passed, with deviations or new source findings

```
Applied {N} findings. The agent flagged {D} deviation(s) / {F} new source finding(s) — review the report above.

Next options:
- Address new source findings inline, or open a fresh `/test-review {scope}` if they warrant a full re-audit.
- `/pre-pr` — proceeds with current state if you accept the deviations.
```

#### Validation failed

```
{N} validation failure(s) — see the report above. The fixes are NOT production-ready.

Next: fix the named test(s), then re-run `/test-fix {slug} --findings={failing indices}`, OR move to `/pre-pr` once clean.
```

In all cases: do not auto-suggest `/test-review` as "another pass". The report is authoritative until source changes or the user explicitly requests a re-audit.

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

7. **Validation**: `npm test -- {test path}`, `npm run lint`, `npm run type-check`, `npm run format:check` must all pass. If `format:check` fails, run `npx prettier --write {edited paths}` and re-verify.

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

- **No plan file written** — in review mode the report in `.reviews/tests-{slug}.md` is the authoritative record. In rescan mode the ledger row is the authoritative record. If you need a persistent multi-sprint plan artefact (for review, handoff, or re-run), use `/test-plan review`.
- **No multi-sprint batching** — single agent spawn, single report (review mode) or single file (rescan mode). For large coverage-driven work, use the plan + write path.
- **No auto re-audit** — neither mode re-runs `/test-review` after fixes. Below-threshold findings from the original report remain below threshold. The validation chain (lint + type-check + tests) IS the convergence signal in review mode; `/test-triage rescan` is the convergence signal in rescan mode.
- **No silent source edits** — source refactors in review mode only run for source findings the user explicitly accepts in Step 5. Source bugs surfaced mid-run are never patched by the agent; they're reported under "New Source Findings" and parked with `it.todo`.
