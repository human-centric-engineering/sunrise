---
allowed-tools: Bash, Glob, Grep, Read, Write, Edit, Agent
description: Ledger-driven triage for codebase-wide test remediation — grade files as Clean/Minor/Bad/Rotten, prioritise fixes
---

## Concurrency Policy

Enforced across all modes that spawn subagents.

| Mode / Path                         | Mechanism                      | Max parallel agents | Batch rule                                    |
| ----------------------------------- | ------------------------------ | ------------------- | --------------------------------------------- |
| Scan (Step 6 Sonnet confirmation)   | Sonnet subagent per hit file   | **5**               | Launch 5, wait for all to finish, then next 5 |
| Path 0 (annotation-only)            | Inline Edit tool — no subagent | —                   | Do all at once                                |
| Path A (`/test-fix from-rescan`)    | Worktree subagent              | **5**               | Launch 5, wait for all to finish, then next 5 |
| Path B (`/test-review → /test-fix`) | Two-stage worktree subagent    | **1**               | Strictly sequential                           |

**Key rule**: cap worktree-spawning agents at 5 concurrently, Sonnet subagents at 5. For a 23-file worklist that means ~5 rounds of fixes instead of 1 wave. Longer wall-clock time, but stays within CPU/memory headroom.

**Never "do it all" in one command.** When a user asks to fix an entire worklist, ask: _"I'll do 5 Rotten files first — run `/test-triage worklist` to see the queue, then we can continue in batches."_ This is the correct default response.

---

Triage tool for remediating the legacy "green-bar" problem across the codebase. This is NOT an audit tool — it grades files fast and cheap, writes to a persistent ledger, and lets you work through the worst files first.

Supports both **unit** and **integration** tests. Type is auto-detected per file from the path (`tests/integration/**` → integration, else unit). A single scan of a folder like `app/api/v1/users` picks up both test types and grades each against the rubric that matches its type.

Use `/test-review` + `/test-fix` for feature-branch BAU work. Use this for the 360+ file / 7.5k-test grind.

## Input

$ARGUMENTS — first token selects the mode:

- `scan <folder> [--all] [--type=unit|integration]` — grade unreviewed (or source-changed-since-scan) test files under `<folder>`. Default batch cap is 20 files. Optional `--type=` filter restricts scan to one test type (default: both).
- `worklist [folder] [--type=unit|integration]` — print prioritised queue (Rotten → Bad → Minor). Optionally filter by folder and/or type.
- `fix <file>` — print the manual review+fix sequence for one file.
- `rescan <file>` — re-grade one file (run this after a fix to update the ledger).

## Ledger

**Location**: `.claude/testing/remediation-ledger.md`

**Format**: YAML frontmatter (rubric version, signature list, per-type rubric map, routing rules) + one markdown table per source folder, rows keyed by test file path. A single folder section can contain both unit and integration rows; the `type` column disambiguates.

Created lazily on first `scan`. Rows are append-only in the sense that removed files keep their row with `grade: gone` for audit history.

**Row schema**:

```
| file | type | grade | sig_hits | block_patterns | test_count | last_head | last_scanned | notes |
```

`type` is `unit` or `integration`. `block_patterns` formatting depends on `type` — unit uses `hpo=N,mp=N,me=N,tcm=N`; integration uses `abm=N,scm=N,dsu=N,erm=N` (see Grade rubric).

## Grade rubric

Grades are density-based (relative to `test_count`) rather than absolute-count-based. A 2-block finding in an 11-test file is not the same severity as a 2-block finding in a 36-test file.

Define:

- `block_sum = sum of block-pattern counts for the file's type` (unit: hpo+mp+me+tcm; integration: abm+scm+dsu+erm)
- `block_density = block_sum / max(test_count, 1)`
- `sig_density = sig_hits / max(test_count, 1)`

Thresholds differ by type — integration tests legitimately run hotter on block density (each test naturally touches more contract surface), so thresholds loosen ~15–20%.

### Unit rubric

| Grade      | Criteria                                                     |
| ---------- | ------------------------------------------------------------ |
| **Rotten** | `block_density > 0.30` OR `block_sum > 8`                    |
| **Bad**    | `block_density >= 0.10` OR `sig_density > 0.20`              |
| **Minor**  | Any `sig_hit >= 1` OR `block_sum >= 1`, under Bad thresholds |
| **Clean**  | 0 signature hits AND 0 block patterns                        |

### Integration rubric

| Grade      | Criteria                                                     |
| ---------- | ------------------------------------------------------------ |
| **Rotten** | `block_density > 0.35` OR `block_sum > 10`                   |
| **Bad**    | `block_density >= 0.15` OR `sig_density > 0.25`              |
| **Minor**  | Any `sig_hit >= 1` OR `block_sum >= 1`, under Bad thresholds |
| **Clean**  | 0 signature hits AND 0 block patterns                        |

Apply top-down, first match wins.

### Block patterns — unit

Sonnet pass identifies these (strictly subset of `/test-review`'s Block tier):

- `happy-path-only (hpo)` — source has error handling, tests don't exercise it
- `mock-proving (mp)` — assertions could be satisfied by deleting the code under test
- `missing-error (me)` — source throws/returns errors, tests don't cover them
- `test-code-mismatch (tcm)` — test describes behaviour that doesn't match source

### Block patterns — integration

Sonnet pass identifies these against the route/handler contract:

- `auth-boundary-missing (abm)` — route enforces auth (401/403), tests only cover authenticated-success paths
- `status-code-missing (scm)` — test invokes the handler but never asserts on `response.status` / the returned status code
- `db-state-unchecked (dsu)` — test performs a POST/PATCH/DELETE mutation but never reads the DB back to verify persistence, or reads only fields the request body trivially dictates
- `error-response-mismatch (erm)` — test asserts an error path but the body shape or error code doesn't match the API's actual `errorResponse()` contract

## Green-bar signatures (regex pass)

Signatures apply to **both** test types — they're generic degenerate-assertion smells. Local, no LLM. Count occurrences per test file:

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

The 5 sig-key tags that can be annotated: `tobe_true`, `find_then_defined`, `no_arg_called`, `empty_not_throw`, `clear_then_notcalled`. Block-tier keys (unit: `happy-path` / `mock-proving` / `missing-error` / `test-mismatch`; integration: `auth-boundary-missing` / `status-code-missing` / `db-state-unchecked` / `error-response-mismatch`) can NEVER be accepted via annotation — block tier means false confidence, not false positive.

Example:

```ts
// test-review:accept tobe_true — isPending is a boolean field on the returned state object; structural assertion, not a degenerate "operation succeeded" check
expect(result.isPending).toBe(true);
```

### Integration files and structural assertions — expected workflow

Integration tests against the Sunrise API contract (`{ success, data|error }` envelope) will reliably hit `tobe_true` on every `expect(body.success).toBe(true)` and `no_arg_called` on "write was attempted" presence checks. These are structural assertions against a real contract, not degenerate smells — but the regex can't tell the difference, so the first scan of a typical integration file will almost always land in **Bad** on `sig_density` alone with `block_sum = 0`.

This is expected. The escape hatch is the accept annotation — it's designed to be used heavily on integration files. The workflow is:

1. First scan: file grades Bad, Sonnet NOTES confirm "all sigs structural".
2. Author adds `// test-review:accept <sig-key> — <rationale>` above each flagged assertion (or above the `it()` block if it's the same pattern repeating).
3. `/test-triage rescan {file}` → sig_hits drops to 0, grade lands Clean.

Use `/test-triage fix {file}` **Path 0** (see fix mode below) for this case. It's cheaper than `/test-fix` because no test code is changing — only comments. Block-tier findings (abm/scm/dsu/erm) always require real fixes; annotations never silence them.

## Type detection

Every file's type is auto-detected from its path:

- `tests/integration/**` → **integration**
- Everything else (`tests/unit/**`, or anywhere else) → **unit**

Printed in scan/rescan output so the user sees which rubric applied. An explicit `--type=unit|integration` flag on `scan` or `worklist` restricts the operation to one type; by default both are included.

## Source↔test path mapping

For scan folder `<folder>`:

- **Unit tests**: `tests/unit/<folder>/**/*.test.{ts,tsx}` — mirrors source folder.
- **Integration tests**: if `<folder>` starts with `app/`, strip the `app/` prefix and glob `tests/integration/<rest>/**/*.test.{ts,tsx}`. Otherwise glob `tests/integration/<folder>/**/*.test.{ts,tsx}` (rare; integration tests typically cover `app/api/` routes).

Example: scan folder `app/api/v1/users`:

- Unit: `tests/unit/app/api/v1/users/**/*.test.{ts,tsx}`
- Integration: `tests/integration/api/v1/users/**/*.test.{ts,tsx}` (note dropped `app/`)

When resolving the source file for a test row:

- Unit: strip `tests/unit/` prefix, replace `.test.ts` → `.ts` / `.test.tsx` → `.tsx`.
- Integration: strip `tests/integration/` prefix, prepend `app/` if the next segment is `api/`, replace `.test.ts` → `.ts`.

---

## Mode: scan

### Step 1: Parse args

`scan <folder> [--all] [--type=unit|integration]`. Require `<folder>`; hard-stop if missing. Default `batch=20`, override with `--all` (no cap). `--type=` restricts to one type; default includes both.

### Step 2: Capture git state

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
date -u +%Y-%m-%dT%H:%M:%SZ
```

### Step 3: Find test files in scope

Use Glob with both mappings from "Source↔test path mapping" above:

- Unit glob: `tests/unit/<folder>/**/*.test.{ts,tsx}`
- Integration glob: apply the `app/` strip rule, then `tests/integration/<rest>/**/*.test.{ts,tsx}`

If `--type=` is present, skip the other glob. Tag each discovered file with its type. If a test file exists but its source counterpart doesn't, skip (orphan test — flag separately in output).

### Step 4: Read ledger, filter to candidates

- If `.claude/testing/remediation-ledger.md` doesn't exist, create it with the frontmatter template (see "Ledger initialisation" below).
- Parse existing rows for test files in scope.
- **Without `--all`**: include file if (a) no ledger row exists, OR (b) the source file's current HEAD differs from the row's `last_head`. Use `git log -1 --format=%H -- <source>` for the per-file HEAD check.
- **With `--all`**: include every test file in scope.
- Cap at `batch` files. If more candidates exist, note in output ("{N} more unreviewed files — re-run `scan` or pass `--all`").

### Step 5: Regex signature pass (main agent, local)

For each candidate file, run the 5 signature regexes via Grep (with `-n` and enough `-B` context to see prior lines) and count matches. Also count `test_count` (it/test invocations). Signatures apply to both types — no branching here.

**Subtract accepted matches**: for every regex hit at line `N`, scan lines `[N-10, N]` of the same file for a `// test-review:accept <key> — ...` comment. If `<key>` equals the sig-key of the match (e.g. `tobe_true`), drop it from the count. The annotation must include the `— ` (em-dash) separator followed by a non-empty rationale; comments without a rationale do not count.

Implementation hint: running Grep with `output_mode: "content"` and `-B 10` per sig-key returns each match with its preceding lines; scan the preceding block for the accept comment before incrementing the counter.

Partition into:

- **Zero-hit files (after subtraction)** — graded directly as `Clean`. No Sonnet pass needed.
- **Hit files** — need Sonnet confirmation pass to check for block patterns. Pass the post-subtraction counts and the file's **type** to the Sonnet prompt; also pass the raw regex counts so Sonnet can sanity-check.

### Step 6: Sonnet confirmation pass (parallel subagents)

For each hit file, spawn ONE Sonnet subagent using the Agent tool with `model: "sonnet"`. **Cap at 5 concurrent subagents** — send up to 5 in a single message, wait for all to complete, then send the next batch of up to 5. If the batch has ≤5 hit files, send them all at once.

Two prompt variants — pick by the file's type.

#### Unit subagent prompt

> You are grading a **unit test** file for codebase remediation triage. This is NOT a full audit — do not prescribe fixes.
>
> **Source**: `{source_path}`
> **Test**: `{test_path}`
> **Type**: unit
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

#### Integration subagent prompt

> You are grading an **integration test** file for codebase remediation triage. This is NOT a full audit — do not prescribe fixes.
>
> **Source (API route / handler)**: `{source_path}`
> **Test**: `{test_path}`
> **Type**: integration
>
> Regex pre-scan found these signature hits (post-annotation — already filtered for `// test-review:accept <key> — ...` comments in the prior 10 lines):
>
> - {sig_key}: {count} occurrences (raw regex count was {raw_count})
>   ...
>
> Do NOT revisit accept annotations — the main agent has already subtracted them. Confirm the remaining counts against the source's actual contract. Integration tests often assert boolean status flags like `expect(response.ok).toBe(true)` or `expect(body.success).toBe(true)` against the Sunrise API envelope — these are structural, not degenerate, so score them as false positives and note it.
>
> **If ALL sigs are structural/legitimate** (no real degenerate assertions), say so explicitly in NOTES using the phrase `all sigs structural — annotation-fixable` followed by the list of sig keys involved. This signals the `/test-triage fix` command to route the user to the annotation-only path (Path 0) rather than a full audit or rewrite.
>
> Read both files. Then identify integration block-tier patterns in the test file. Integration tests exercise the full route contract (request → validation → auth → handler → DB → response), so look for gaps in that chain:
>
> 1. `auth-boundary-missing` — does the route enforce auth via `withAuth()`, `withAdminAuth()`, or a manual session check? If yes, count missing tests for the 401 (unauthenticated) and 403 (wrong role) paths. 0 if route is public.
> 2. `status-code-missing` — count tests that invoke the handler (`POST(...)`, `GET(...)`, `handler(...)`) but never assert on `response.status` / the returned status code. Asserting only on body shape without status is a common silent-regression vector.
> 3. `db-state-unchecked` — for POST/PATCH/DELETE mutation tests, count those that assert on the response body but never read the DB back (via Prisma `findUnique` / `findFirst` / `findMany`) to verify persistence. Reading back only fields the request body trivially dictates (e.g. `expect(user.email).toBe(requestBody.email)`) still counts as "unchecked" — look for state the handler derived or transformed.
> 4. `error-response-mismatch` — count tests that assert on error responses where the asserted body shape or error code doesn't match the API's `errorResponse()` contract (`{ success: false, error: { code, message, details? } }`). If tests assert `{ error: 'string' }` or similar drift, flag them.
>
> Output exactly this format, no preamble:
>
> ```
> BLOCK_PATTERNS:
> - auth-boundary-missing: {N}
> - status-code-missing: {N}
> - db-state-unchecked: {N}
> - error-response-mismatch: {N}
>
> CONFIRMED_SIGS:
> - {sig_key}: {real_count} (regex said {regex_count})
> ...
>
> NOTES: {one line — e.g. "route enforces withAdminAuth but no 403 test; 4 mutations unchecked against DB"}
> ```
>
> Keep it compact. If a pattern has 0 instances, still list the key with 0.

### Step 7: Apply rubric, grade each file

For each scanned file, apply the rubric that matches its type using the authoritative counts (Sonnet's `CONFIRMED_SIGS` for hit files; regex counts otherwise).

- `block_sum = sum(BLOCK_PATTERNS counts)`, or 0 if no Sonnet pass.
- `block_density = block_sum / max(test_count, 1)`
- `sig_density = sig_hits / max(test_count, 1)`

Unit thresholds (`type == unit`):

- If `block_density > 0.30 OR block_sum > 8` → **Rotten**
- Else if `block_density >= 0.10 OR sig_density > 0.20` → **Bad**
- Else if `sig_hits >= 1 OR block_sum >= 1` → **Minor**
- Else → **Clean**

Integration thresholds (`type == integration`):

- If `block_density > 0.35 OR block_sum > 10` → **Rotten**
- Else if `block_density >= 0.15 OR sig_density > 0.25` → **Bad**
- Else if `sig_hits >= 1 OR block_sum >= 1` → **Minor**
- Else → **Clean**

### Step 8: Update ledger

- If the file has an existing row, update it in place.
- Otherwise append to the appropriate folder section (create section if absent).
- Row values: `type` (unit/integration), `grade`, `sig_hits`, `block_patterns` (per-type format: unit `hpo=N,mp=N,me=N,tcm=N`; integration `abm=N,scm=N,dsu=N,erm=N`), `test_count`, `last_head` (file-specific HEAD), `last_scanned` (ISO timestamp), `notes` (from Sonnet).

Write atomically (read full file → modify → write full file).

### Step 9: Print scan summary

```
## /test-triage scan — {folder}

**Scanned**: {N} files ({batch_size}/{total_in_scope}, {remaining} unreviewed)
**Types**: {U} unit · {I} integration
**HEAD**: {head-short} · **Branch**: {branch}

**Grades**:
- Rotten: {N}
- Bad: {N}
- Minor: {N}
- Clean: {N}

**Worst this batch**:
- `{file}` [{type}] — Rotten · {sig_hits} sigs · block: {pattern summary}
- `{file}` [{type}] — Rotten · {sig_hits} sigs · block: {pattern summary}
- (up to 5)

Ledger: `.claude/testing/remediation-ledger.md`
Next: `/test-triage worklist {folder}` to see the prioritised queue, then `/test-triage fix <file>` on the worst.
```

---

## Mode: worklist

### Step 1: Parse args

`worklist [folder] [--type=unit|integration]` — optional folder filter, optional type filter.

### Step 2: Read ledger

Hard-stop with "Ledger not found — run `/test-triage scan <folder>` first" if absent.

### Step 3: Filter and sort

- Filter out `grade: gone` rows.
- Filter by folder if provided.
- Filter by type if `--type=` provided.
- Sort by: grade (Rotten > Bad > Minor > Clean) then by `sig_hits + 3*block_sum` descending (prioritise within-grade by severity).

**Note on cross-type sorting**: within-type severity is comparable; cross-type is approximate (the block-pattern sets differ). Worklist keeps the simple sort and relies on the `type` column in each row so users can eyeball what they're prioritising.

### Step 4: Print queue

```
## Remediation Worklist {— folder if filter}{— type if filter}

**Totals**: {Rotten} Rotten · {Bad} Bad · {Minor} Minor · {Clean} Clean · {U} unit / {I} integration

### Rotten ({N} files)
- `{file}` [{type}] — {sig_hits} sigs, {block_summary} · last scanned {date}
- ...

### Bad ({N} files)
- `{file}` [{type}] — {sig_hits} sigs, {block_summary}
- ...

### Minor ({N} files)
(collapsed — use `worklist --verbose` to expand) or list if N ≤ 10

### Suggested next
Start with the first 1–3 Rotten files — **do not launch all at once**:

- Path A files (Bad/Minor with clear notes): pick up to 3 and run `/test-fix from-rescan` on each in parallel.
- Path B files (Rotten or vague notes): run one at a time with `/test-review → /test-fix`.
- Path 0 files (annotation-only): can all be done inline without agents.

Typical flow: `/test-triage fix {file1}`, `/test-triage fix {file2}`, `/test-triage fix {file3}` → wait → rescan → continue.
```

Cap each section at 20 rows in chat output; full list is in the ledger.

---

## Mode: fix

### Step 1: Parse args and look up

`fix <file>` — require file path. Read the ledger; warn if no row exists for the file (the user can still proceed, but grade won't be updated).

### Step 2: Print manual sequence

Before printing, check the ledger row for the **annotation-only** trigger condition:

- `block_sum == 0` AND `sig_hits >= 1` AND notes contain the phrase `all sigs structural — annotation-fixable` (or close variant).

If triggered, print Path 0 as the recommended first step. Otherwise, print Paths A and B only.

```
## /test-triage fix — {file}

**Type**: {unit | integration}
**Current grade**: {grade} · {sig_hits} sigs · block: {summary}
**Ledger notes**: {notes}

### Paths — pick based on grade and notes

{If annotation-only trigger matched, print Path 0 first:}

**Path 0 — annotation-only** (recommended: the ledger notes say sigs are structural against a real contract, not degenerate):

1. Open `{file}` and locate the flagged assertion lines from the notes (or re-run the regex pass manually if line numbers weren't captured).
2. Above each flagged assertion — or above the `it()` block if the same pattern repeats — add:
```

// test-review:accept <sig-key> — <rationale>

```
Use the sig-key named in NOTES (`tobe_true`, `no_arg_called`, etc.). The rationale should name the contract being asserted (e.g. "structural assertion on Sunrise API `{ success, data }` envelope, not a degenerate 'operation succeeded' check").
3. `/test-triage rescan {file}` — sig_hits drops to 0 on confirmed-structural hits; grade should land Clean (or drop to whatever block-tier findings remain).

No test code changes. Typical for integration files on first scan against the API envelope. If rescan doesn't drop sig_hits to 0, an annotation is missing a flagged line or the rationale is malformed — check the em-dash separator and sig-key match.

**Path A — rescan-driven fast path** (good when notes name specific, tractable gaps):

1. `/test-fix from-rescan {file}` — reads the ledger notes, spawns a test-engineer to patch the findings, validates with lint + type-check + tests.
2. `/test-triage rescan {file}` — re-grades and updates the ledger.

Best for **Minor** and **Bad** files with 1–3 specific findings. Cheaper than Path B, and often enough to move the grade.

**Path B — full audit path** (good for Rotten, or when notes feel vague/structural):

1. `/test-review {file}` — full audit, produces `.reviews/tests-{slug}.md`.
2. Resolve any `Source Findings` with `pending` status (reply `fix them` / `document {finding}` / `skip {finding}`).
3. `/test-fix {file}` — applies Rewrite/Add/Delete. Validates.
4. `/test-triage rescan {file}` — re-grades and updates the ledger.

Slower but produces per-test Keep/Rewrite/Add/Delete prescriptions with source-finding handling. Use when rescan notes don't give enough to work from, or when you suspect source bugs.

If any path reports deviations or new source findings, decide whether to capture them in `gotchas.md` via the capture hook, then rescan.
```

No subagent spawn in this mode — it's a user-facing instruction print. Keeps the triage/BAU boundary clean.

> **Batch note**: if you're running this path across multiple files, cap at 3 concurrent Path A agents or 1 Path B agent at a time. Wait for results before launching the next batch. See **Concurrency Policy** at the top of this file.

---

## Mode: rescan

### Step 1: Parse args

`rescan <file>` — require file path.

### Step 2: Resolve type and run the scan pipeline for one file

Detect type from path (`tests/integration/**` → integration, else unit). If an existing ledger row exists, its type should match — if not (e.g., a file moved from `tests/unit/` to `tests/integration/`), print a one-line warning and use the path-derived type.

Repeat Steps 2, 5, 6, 7, 8 of `scan` mode for just this file. Signature pass + Sonnet confirmation if hits > 0 (using the type-matched prompt) + rubric (using type-matched thresholds) + ledger update.

### Step 3: Print delta and next-step guidance

```
## /test-triage rescan — {file}

**Type**: {unit | integration}
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
- **Bad with `block_sum = 0` AND NOTES say `all sigs structural — annotation-fixable`** → Path 0 from `/test-triage fix {file}`. Add `// test-review:accept <sig-key> — <rationale>` above flagged assertions, then rescan. Typical for integration files against the API envelope. No test code changes.
- **Minor** → a legitimate stopping point for most files. If you want to push further, use `/test-fix from-rescan {file}` — cheaper than a full review and often moves the grade.
- **Bad** with specific, actionable NOTES (block-tier findings present) → `/test-fix from-rescan {file}` first. Escalate to `/test-review {file}` only if the NOTES feel vague, the fix needs source changes, or a first `from-rescan` loop didn't move the grade in the direction you expected.
- **Rotten**, or NOTES describe structural/ambiguous issues → `/test-review {file}` for audit-level prescriptions per test. The shortcut isn't suited for deep rot.

Stopping early is fine. The ledger records the grade — the next pass over the codebase can pick it back up.
```

---

## Ledger initialisation

When `scan` runs for the first time and `.claude/testing/remediation-ledger.md` is absent, create it with:

```markdown
---
version: 2
scope: tests
rubric_version: 3
routing:
  tests/integration/**: integration
  tests/unit/**: unit
  default: unit
signatures:
  - empty_not_throw
  - find_then_defined
  - no_arg_called
  - tobe_true
  - clear_then_notcalled
rubrics:
  unit:
    clean: '0 signature hits AND 0 block patterns'
    minor: 'any sig hit or block finding, under Bad thresholds'
    bad: 'block_density >= 0.10 OR sig_density > 0.20'
    rotten: 'block_density > 0.30 OR block_sum > 8'
    block_patterns:
      - happy-path-only (hpo)
      - mock-proving (mp)
      - missing-error (me)
      - test-code-mismatch (tcm)
    block_summary_format: 'hpo=N,mp=N,me=N,tcm=N'
  integration:
    clean: '0 signature hits AND 0 block patterns'
    minor: 'any sig hit or block finding, under Bad thresholds'
    bad: 'block_density >= 0.15 OR sig_density > 0.25'
    rotten: 'block_density > 0.35 OR block_sum > 10'
    block_patterns:
      - auth-boundary-missing (abm)
      - status-code-missing (scm)
      - db-state-unchecked (dsu)
      - error-response-mismatch (erm)
    block_summary_format: 'abm=N,scm=N,dsu=N,erm=N'
---

# Test Remediation Ledger

Tracks grading of unit and integration tests for codebase-wide remediation. Updated by `/test-triage scan` and `/test-triage rescan`. Used by `/test-triage worklist` to prioritise fixes.

Test type is auto-detected from path (`tests/integration/**` → integration, else unit). Each row carries a `type` column so mixed-type folders sort/filter cleanly. Block patterns and rubric thresholds differ by type — see frontmatter.

Grades are deterministic given the signature/block counts — see rubric above.
```

Folder sections are added on-demand as `scan` encounters test files under a given source folder (e.g. `## lib/auth`, `## app/api/v1/users`). A single folder section can mix unit and integration rows.

---

## What this command does NOT do

- **No test writes or rewrites** — `fix` is an instruction printer; `/test-fix` does the actual work.
- **No deep audits** — grading is signature-driven + narrow-scope Sonnet check, not the full `/test-review` pipeline. Rotten grade means "likely rotten, fix it"; it does not produce prescriptions.
- **No coverage analysis** — use `/test-coverage`. Triage is about _quality_ of existing tests, not gaps.
- **No E2E / browser-driven test support** — the rubric is tuned for Vitest unit and Vitest integration (mocked route handlers / testcontainers). Playwright E2E would need its own block-pattern set.
