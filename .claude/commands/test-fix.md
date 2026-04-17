---
allowed-tools: Bash, Glob, Grep, Read, Agent
description: Fast-path executor for quality-fix passes — applies /test-review findings directly without an intermediate plan file
---

Fast-path executor for quality-fix passes. Reads `.claude/tmp/test-review.md` directly and spawns a single test-engineer subagent to apply the Rewrite/Add/Delete items across the scope.

Use this after `/test-review` when the scope is small (1–5 files) and the work is quality fixes, not coverage expansion. For larger scopes or coverage-driven work, use `/test-plan review` + `/test-write plan`.

## Input

$ARGUMENTS — optional scope filter:

- **No arguments** → apply all file entries from the review
- **File or folder path** → apply only review entries that match the path (e.g. `components/analytics/user-identifier.tsx` or `lib/auth`)

## Steps

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

```
Next:
- `/test-review {scope}` — re-audit the fixes landed
- `/test-coverage {scope}` — verify thresholds still met
- `/pre-pr` — final validation before opening a PR
```

---

## What this command does NOT do

- **No plan file written** — the review file remains the authoritative record. If you need a persistent plan artefact (for review, handoff, or re-run), use `/test-plan review`.
- **No multi-sprint batching** — single agent spawn, all files in one context. For 6+ files or mixed-complexity scopes, the plan + write path is better.
- **No source-file edits beyond what the test-engineer agent itself does** — source fixes for Source Findings happen upstream in the review conversation; this command assumes every finding is already `resolved` or `accepted`.
