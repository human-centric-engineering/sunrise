---
allowed-tools: Bash, Glob, Grep, Read, Write, Edit, Agent
description: Ledger-driven triage for codebase-wide test remediation — grade files as Clean/Minor/Bad/Rotten, prioritise fixes
---

Triage tool for remediating the legacy "green-bar" problem across the codebase. This is NOT an audit tool — it grades files fast and cheap, writes to a persistent ledger, and lets you work through the worst files first.

Use `/test-review` + `/test-fix` for feature-branch BAU work. Use this for the 360+ file / 7.5k-test grind.

## Input

$ARGUMENTS — first token selects the mode:

- `scan <folder> [--all]` — grade unreviewed (or source-changed-since-scan) test files under `<folder>`. Default batch cap is 20 files.
- `worklist [folder]` — print prioritised queue (Rotten → Bad → Minor). Optionally filter by folder.
- `fix <file>` — print the manual review+fix sequence for one file.
- `rescan <file>` — re-grade one file (run this after a fix to update the ledger).

## Ledger

**Location**: `.claude/testing/remediation-ledger.md`

**Format**: YAML frontmatter (rubric version, signature list, block-pattern list) + one markdown table per top-level folder, rows keyed by test file path.

Created lazily on first `scan`. Rows are append-only in the sense that removed files keep their row with `grade: gone` for audit history.

**Row schema**:

```
| file | grade | sig_hits | block_patterns | test_count | last_head | last_scanned | notes |
```

## Grade rubric

Grades are density-based (relative to `test_count`) rather than absolute-count-based. A 2-block finding in an 11-test file is not the same severity as a 2-block finding in a 36-test file.

Define:

- `block_sum = hpo + mp + me + tcm`
- `block_density = block_sum / max(test_count, 1)`
- `sig_density = sig_hits / max(test_count, 1)`

Apply top-down, first match wins:

| Grade      | Criteria                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| **Rotten** | `block_density > 0.3` OR `block_sum > 8` (structural rot — typically "helper re-implements source" pattern) |
| **Bad**    | `block_density >= 0.1` OR `sig_density > 0.2` (significant quality issues but tractable)                    |
| **Minor**  | Any `sig_hit >= 1` OR `block_sum >= 1`, under Bad thresholds                                                |
| **Clean**  | 0 signature hits AND 0 block patterns                                                                       |

**Block patterns** (Sonnet pass identifies these; strictly subset of `/test-review`'s Block tier):

- `happy-path-only` — source has error handling, tests don't exercise it
- `mock-proving` — assertions could be satisfied by deleting the code under test
- `missing-error` — source throws/returns errors, tests don't cover them
- `test-code-mismatch` — test describes behaviour that doesn't match source

## Green-bar signatures (regex pass)

Local, no LLM. Count occurrences per test file:

| Key                    | Regex (approx)                                                                                                                                                                                                                  | Meaning                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `empty_not_throw`      | `expect\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)\.not\.toThrow`                                                                                                                                                                          | `.not.toThrow()` on empty arrow — asserts nothing        |
| `find_then_defined`    | `\.find\([^)]*\)\.toBeDefined\(\)` OR `.toBeDefined()` with `.find(` in prior 3 lines                                                                                                                                           | find-result existence without property assertion         |
| `no_arg_called`        | `[^t]\.toHaveBeenCalled\(\s*\)` (the leading `[^t]` excludes `.not.toHaveBeenCalled()` — negative-form assertions are semantically specific, not degenerate; `\(\s*\)` excludes `toHaveBeenCalledWith`/`toHaveBeenCalledTimes`) | mock called check with no arg shape (positive form only) |
| `tobe_true`            | `expect\([^)]*\)\.toBe\(true\)`                                                                                                                                                                                                 | degenerate boolean assertion                             |
| `clear_then_notcalled` | file contains both `vi\.clearAllMocks\(\)` inside an `it(` block AND `not\.toHaveBeenCalled`                                                                                                                                    | mid-test mock reset masking regression                   |

Total `sig_hits` = sum across keys. `test_count` = matches of `\b(it|test)(\.each)?\(` in the file.

### Accept annotations

Signature matches can be dismissed as false positives using the `// test-review:accept <sig-key> — <rationale>` comment (same grammar as `/test-review`; see `.claude/commands/test-review.md` for the full spec). A match at line `N` is skipped if a `// test-review:accept <matching-key> — ...` comment appears in the range `[N-10, N]`. Accepted matches do NOT count toward `sig_hits`.

The 5 sig-key tags that can be annotated: `tobe_true`, `find_then_defined`, `no_arg_called`, `empty_not_throw`, `clear_then_notcalled`. Block-tier keys (`happy-path`, `mock-proving`, `missing-error`, `test-mismatch`) can NEVER be accepted via annotation — block tier means false confidence, not false positive.

Example:

```ts
// test-review:accept tobe_true — isPending is a boolean field on the returned state object; structural assertion, not a degenerate "operation succeeded" check
expect(result.isPending).toBe(true);
```

---

## Mode: scan

### Step 1: Parse args

`scan <folder> [--all]`. Require `<folder>`; hard-stop if missing. Default `batch=20`, override with `--all` (no cap).

### Step 2: Capture git state

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
date -u +%Y-%m-%dT%H:%M:%SZ
```

### Step 3: Find test files in scope

Use Glob to find test files that mirror source files under `<folder>`:

- Glob pattern: `tests/unit/<folder>/**/*.test.{ts,tsx}` (adjust for folders outside `lib/`, `components/`, `app/`)
- If a test file exists but its source counterpart doesn't, skip (orphan test — flag separately in output)

### Step 4: Read ledger, filter to candidates

- If `.claude/testing/remediation-ledger.md` doesn't exist, create it with the frontmatter template (see "Ledger initialisation" below).
- Parse existing rows for test files in scope.
- **Without `--all`**: include file if (a) no ledger row exists, OR (b) the source file's current HEAD differs from the row's `last_head`. Use `git log -1 --format=%H -- <source>` for the per-file HEAD check.
- **With `--all`**: include every test file in scope.
- Cap at `batch` files. If more candidates exist, note in output ("{N} more unreviewed files — re-run `scan` or pass `--all`").

### Step 5: Regex signature pass (main agent, local)

For each candidate file, run the 5 signature regexes via Grep (with `-n` and enough `-B` context to see prior lines) and count matches. Also count `test_count` (it/test invocations).

**Subtract accepted matches**: for every regex hit at line `N`, scan lines `[N-10, N]` of the same file for a `// test-review:accept <key> — ...` comment. If `<key>` equals the sig-key of the match (e.g. `tobe_true`), drop it from the count. The annotation must include the `— ` (em-dash) separator followed by a non-empty rationale; comments without a rationale do not count.

Implementation hint: running Grep with `output_mode: "content"` and `-B 10` per sig-key returns each match with its preceding lines; scan the preceding block for the accept comment before incrementing the counter.

Partition into:

- **Zero-hit files (after subtraction)** — graded directly as `Clean`. No Sonnet pass needed.
- **Hit files** — need Sonnet confirmation pass to check for block patterns. Pass the post-subtraction counts to the Sonnet prompt; also pass the raw regex counts so Sonnet can sanity-check.

### Step 6: Sonnet confirmation pass (parallel subagents)

For each hit file, spawn ONE Sonnet subagent using the Agent tool with `model: "sonnet"`. Send all calls in a single message for parallelism.

**Subagent prompt template**:

> You are grading a test file for codebase remediation triage. This is NOT a full audit — do not prescribe fixes.
>
> **Source**: `{source_path}`
> **Test**: `{test_path}`
>
> Regex pre-scan found these signature hits (post-annotation — already filtered for `// test-review:accept <key> — ...` comments in the prior 10 lines):
>
> - {sig_key}: {count} occurrences (raw regex count was {raw_count})
>   ...
>
> Do NOT revisit accept annotations — the main agent has already subtracted them. Confirm the remaining counts against the source's actual contract (are they truly degenerate, or legitimate structural assertions the annotation layer missed?). If you flag a regex match as a false positive that SHOULD have been annotated, say so in NOTES — that's a signal the author could add an annotation.
>
> Read both files. Then identify block-tier patterns in the test file:
>
> 1. `happy-path-only` — does source have error handling (throws, 4xx/5xx returns, catch blocks, validation failures) that tests don't exercise? How many distinct error paths are untested?
> 2. `mock-proving` — are there assertions that would pass even if the code under test were deleted? Count distinct tests affected.
> 3. `missing-error` — count source-defined error conditions with no corresponding test.
> 4. `test-code-mismatch` — any tests whose described behaviour doesn't match the source's actual behaviour? Count.
>
> Output exactly this format, no preamble:
>
> ```
> BLOCK_PATTERNS:
> - happy-path-only: {N}
> - mock-proving: {N}
> - missing-error: {N}
> - test-code-mismatch: {N}
>
> CONFIRMED_SIGS:
> - {sig_key}: {real_count} (regex said {regex_count})
> ...
>
> NOTES: {one line — e.g. "5 source error paths untested; mock-proving in user creation tests"}
> ```
>
> Keep it compact. If a pattern has 0 instances, still list the key with 0.

### Step 7: Apply rubric, grade each file

For each scanned file, apply the rubric using the authoritative counts (Sonnet's `CONFIRMED_SIGS` for hit files; regex counts otherwise).

- `block_sum = sum(BLOCK_PATTERNS counts)`, or 0 if no Sonnet pass.
- `block_density = block_sum / max(test_count, 1)`
- `sig_density = sig_hits / max(test_count, 1)`

Apply top-down, first match wins:

- If `block_density > 0.3 OR block_sum > 8` → **Rotten**
- Else if `block_density >= 0.1 OR sig_density > 0.2` → **Bad**
- Else if `sig_hits >= 1 OR block_sum >= 1` → **Minor**
- Else → **Clean**

### Step 8: Update ledger

- If the file has an existing row, update it in place.
- Otherwise append to the appropriate folder section (create section if absent).
- Row values: `grade`, `sig_hits`, `block_patterns` (as `hpo=N,mp=N,me=N,tcm=N`), `test_count`, `last_head` (file-specific HEAD), `last_scanned` (ISO timestamp), `notes` (from Sonnet).

Write atomically (read full file → modify → write full file).

### Step 9: Print scan summary

```
## /test-triage scan — {folder}

**Scanned**: {N} files ({batch_size}/{total_in_scope}, {remaining} unreviewed)
**HEAD**: {head-short} · **Branch**: {branch}

**Grades**:
- Rotten: {N}
- Bad: {N}
- Minor: {N}
- Clean: {N}

**Worst this batch**:
- `{file}` — Rotten · {sig_hits} sigs · block: {pattern summary}
- `{file}` — Rotten · {sig_hits} sigs · block: {pattern summary}
- (up to 5)

Ledger: `.claude/testing/remediation-ledger.md`
Next: `/test-triage worklist {folder}` to see the prioritised queue, then `/test-triage fix <file>` on the worst.
```

---

## Mode: worklist

### Step 1: Parse args

`worklist [folder]` — optional folder filter.

### Step 2: Read ledger

Hard-stop with "Ledger not found — run `/test-triage scan <folder>` first" if absent.

### Step 3: Filter and sort

- Filter out `grade: gone` rows.
- Filter by folder if provided.
- Sort by: grade (Rotten > Bad > Minor > Clean) then by `sig_hits + 3*block_sum` descending (prioritise within-grade by severity).

### Step 4: Print queue

```
## Remediation Worklist {— folder if filter}

**Totals**: {Rotten} Rotten · {Bad} Bad · {Minor} Minor · {Clean} Clean

### Rotten ({N} files)
- `{file}` — {sig_hits} sigs, {block_summary} · last scanned {date}
- ...

### Bad ({N} files)
- `{file}` — {sig_hits} sigs, {block_summary}
- ...

### Minor ({N} files)
(collapsed — use `worklist --verbose` to expand) or list if N ≤ 10

### Suggested next
Start with: `/test-triage fix {first Rotten file}`
```

Cap each section at 20 rows in chat output; full list is in the ledger.

---

## Mode: fix

### Step 1: Parse args and look up

`fix <file>` — require file path. Read the ledger; warn if no row exists for the file (the user can still proceed, but grade won't be updated).

### Step 2: Print manual sequence

```
## /test-triage fix — {file}

**Current grade**: {grade} · {sig_hits} sigs · block: {summary}
**Ledger notes**: {notes}

### Two paths — pick based on grade and notes

**Path A — rescan-driven fast path** (good when notes name specific, tractable gaps):

1. `/test-fix from-rescan {file}` — reads the ledger notes, spawns a test-engineer to patch the findings, validates with lint + type-check + tests.
2. `/test-triage rescan {file}` — re-grades and updates the ledger.

Best for **Minor** and **Bad** files with 1–3 specific findings. Cheaper than Path B, and often enough to move the grade.

**Path B — full audit path** (good for Rotten, or when notes feel vague/structural):

1. `/test-review {file}` — full audit, produces `.claude/tmp/test-review.md`.
2. Resolve any `Source Findings` with `pending` status (reply `fix them` / `document {finding}` / `skip {finding}`).
3. `/test-fix {file}` — applies Rewrite/Add/Delete. Validates.
4. `/test-triage rescan {file}` — re-grades and updates the ledger.

Slower but produces per-test Keep/Rewrite/Add/Delete prescriptions with source-finding handling. Use when rescan notes don't give enough to work from, or when you suspect source bugs.

If either path reports deviations or new source findings, decide whether to capture them in `gotchas.md` via the capture hook, then rescan.
```

No subagent spawn in this mode — it's a user-facing instruction print. Keeps the triage/BAU boundary clean.

---

## Mode: rescan

### Step 1: Parse args

`rescan <file>` — require file path.

### Step 2: Run the scan pipeline for one file

Repeat Steps 2, 5, 6, 7, 8 of `scan` mode for just this file. Signature pass + Sonnet confirmation if hits > 0 + rubric + ledger update.

### Step 3: Print delta and next-step guidance

```
## /test-triage rescan — {file}

**Before**: {old_grade} · {old_sig_hits} sigs · block: {old_block_summary}
**After**:  {new_grade} · {new_sig_hits} sigs · block: {new_block_summary}

{If grade improved:} ✓ Upgraded from {old} to {new}.
{If grade unchanged:} No grade change — fixes didn't move signature or block counts enough. Review test file and re-fix if needed.
{If grade worsened:} ⚠ Grade worsened from {old} to {new}. Likely a regression during fix — check the last /test-fix output.

**Sonnet NOTES**: {NOTES line from the confirmation pass, or "—" if file is Clean / skipped Sonnet}

Ledger updated.

### Next step — subjective, use judgement

Neither path guarantees convergence in one shot. Both `/test-review → /test-fix` and the `from-rescan` shortcut exhibit narrow-audit variance — each Sonnet pass surfaces slightly different edges of the same class of issues. Match the effort to how much it matters.

- **Clean** → done. Pick the next file from `/test-triage worklist`.
- **Minor** → a legitimate stopping point for most files. If you want to push further, use `/test-fix from-rescan {file}` — cheaper than a full review and often moves the grade.
- **Bad** with specific, actionable NOTES → `/test-fix from-rescan {file}` first. Escalate to `/test-review {file}` only if the NOTES feel vague, the fix needs source changes, or a first `from-rescan` loop didn't move the grade in the direction you expected.
- **Rotten**, or NOTES describe structural/ambiguous issues → `/test-review {file}` for audit-level prescriptions per test. The shortcut isn't suited for deep rot.

Stopping early is fine. The ledger records the grade — the next pass over the codebase can pick it back up.
```

---

## Ledger initialisation

When `scan` runs for the first time and `.claude/testing/remediation-ledger.md` is absent, create it with:

```markdown
---
version: 1
scope: unit-tests
rubric_version: 2
rubric:
  clean: '0 signature hits AND 0 block patterns'
  minor: 'any sig hit or block finding, under Bad thresholds'
  bad: 'block_density >= 0.1 OR sig_density > 0.2'
  rotten: 'block_density > 0.3 OR block_sum > 8'
signatures:
  - empty_not_throw
  - find_then_defined
  - no_arg_called
  - tobe_true
  - clear_then_notcalled
block_patterns:
  - happy-path-only (hpo)
  - mock-proving (mp)
  - missing-error (me)
  - test-code-mismatch (tcm)
block_summary_format: 'hpo=N,mp=N,me=N,tcm=N'
---

# Test Remediation Ledger

Tracks grading of unit tests for codebase-wide remediation. Updated by `/test-triage scan` and `/test-triage rescan`. Used by `/test-triage worklist` to prioritise fixes.

Grades are deterministic given the signature/block counts — see rubric above.
```

Folder sections are added on-demand as `scan` encounters test files under a given top-level folder (e.g. `## lib/auth`, `## components/admin/orchestration`).

---

## What this command does NOT do

- **No test writes or rewrites** — `fix` is an instruction printer; `/test-fix` does the actual work.
- **No deep audits** — grading is signature-driven + narrow-scope Sonnet check, not the full `/test-review` pipeline. Rotten grade means "likely rotten, fix it"; it does not produce prescriptions.
- **No coverage analysis** — use `/test-coverage`. Triage is about _quality_ of existing tests, not gaps.
- **No integration test support (v1)** — `tests/integration/` has different smell patterns. Separate rubric later.
