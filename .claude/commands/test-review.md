---
allowed-tools: Bash, Glob, Grep, Read, Write, Agent
description: Audit test quality with bounded convergence — Block / Improve / Catalog tiers
---

Review existing tests for quality issues with a tier model designed to converge: **Block** (must fix — false confidence), **Improve** (recommended — mechanical, names a specific regression, <5 min to apply), **Catalog** (recorded for context, not actioned).

The convergence guarantee comes from two rules: (1) Improve items must meet all three criteria — anything subjective lands in Catalog; (2) `/test-fix` running clean (lint + type-check + tests) is the validation signal — no reflex re-audit. Re-run `/test-review` only on source change, explicit user ask, or `/pre-pr`.

**Production-ready** = zero Block findings AND every Improve item resolved (fixed or accept-annotated). Catalog items never gate merge.

**Performance:** For 2+ file pairs, this command parallelizes audits across Sonnet subagents (one per file pair), then uses the main model for source-finding synthesis and aggregation. For a single file pair, it runs inline.

**Context discipline:** The main agent does NOT read source or test files unless source-finding synthesis specifically requires it. Subagents read their own file pair — passing file contents through the main context defeats the purpose of delegation.

**Accept annotations:** Improve items that represent intentional, conscious trade-offs (jsdom limitations, boundary coverage decisions, etc.) can be marked as accepted inline in the test file using `// test-review:accept <issue-type> — <rationale>`. See the "Accept annotations" section below for the grammar and matching rules. Accepted findings appear in the review's `### Accepted` subsection (for audit/re-evaluation) but do NOT count as Improve items and do NOT appear in Structured Findings.

## Input

$ARGUMENTS — optional file paths, folder paths, or test file paths. If omitted, defaults to reviewing tests for code changed on the current branch vs `origin/main`.

## Steps

### Step 1: Identify test files to review

**If arguments are test files** (paths containing `tests/` or ending in `.test.ts`/`.test.tsx`):

- Review those test files directly.

**If arguments are source files or folders**:

- Find the corresponding test files using project conventions:
  - `lib/foo/bar.ts` → `tests/unit/lib/foo/bar.test.ts`
  - `app/api/v1/foo/route.ts` → `tests/unit/app/api/v1/foo/route.test.ts`
  - For folders, find all test files that correspond to source files in the folder.

**If no arguments** (branch diff mode):

- Resolve base ref:
  ```bash
  git fetch origin main --quiet
  BASE=$(git merge-base origin/main HEAD)
  ```
- Get changed files: `git diff --name-only $BASE...HEAD`
- Find corresponding test files for all changed `.ts`/`.tsx` source files.
- Also include any test files that were directly changed on the branch.

If no test files are found, report "No test files found to review" and stop.

### Step 2: Build the file-pair list

**Do NOT read source or test files into the main context.** Resolve pairs by path only:

- For each test file identified in Step 1, compute its corresponding source path using project conventions (`tests/unit/...` → mirror in source tree; `.test.tsx` → `.tsx`).
- If a test file exists but its source counterpart doesn't, flag it (likely a rename/delete). Otherwise keep the pair.
- Optionally use `Glob` to verify paths exist — do not `Read` them.

Output of this step is a simple list: `[{ testFile, sourceFile }, ...]`. This drives Step 3.

### Step 3: Audit test files — parallel or inline

**Decision:** If there are **2 or more file pairs**, use parallel Sonnet subagents (Step 3a). If there is a **single file pair**, audit inline (Step 3b).

#### Step 3a: Parallel audit (2+ file pairs)

Spawn one **Sonnet** subagent per file pair using the Agent tool with `model: "sonnet"`. Send all Agent tool calls in a **single message** so they run in parallel.

The subagent reads its own file pair — do NOT inline file contents in the prompt. This keeps the main context small and the subagent's context focused.

**Subagent prompt template:**

> You are a test quality auditor. Read both files below and identify quality issues in the test file.
>
> **Source file**: `{source_path}`
> **Test file**: `{test_path}`
>
> Start by calling Read on BOTH files. Then apply the audit checklist below. Do not read other files unless they are directly imported by the test and the import is central to the finding.
>
> ## Audit checklist
>
> Classify each finding into one of three tiers:
>
> - **block** — test gives false confidence; a real regression could land green. Always action. Sources: 3a (happy-path), 3b (mock-proving), 3d (missing-error), 3f (test-mismatch).
> - **improve** — recommended fix that meets ALL THREE gates: (1) **mechanical** — single-pattern replacement, not "rethink the test"; (2) **names a specific regression** — you can state the concrete bug current test would miss; (3) **<5 minutes to apply**. If any gate fails, drop to catalog. Sources: 3c (weak-assert), 3e (brittle), 3g (untested-path) — only when the gate passes.
> - **catalog** — recorded for the next reviewer's context, NOT actioned. This is where everything subjective lives — style nits, near-duplicates, weak-but-not-masking assertions, untested branches that aren't worth a separate test, redundant patterns. Catalog items never appear in REWRITE / ADD / DELETE.
>
> The "rule of thumb" for improve vs catalog: can you write a one-line `Should:` that names a specific regression, AND is the fix a single mechanical edit a junior dev could apply in <5 min? If yes to both → improve. If no to either → catalog. When in doubt, catalog.
>
> **Accept annotations**: scan the test file for comments matching `// test-review:accept <issue-type> — <rationale>`. If an improve item you would otherwise emit at line `N` has a matching annotation (same `<issue-type>`) in the range `[N-10, N]`, move that finding to `ACCEPTED:` in your output — do NOT emit it under `IMPROVE:` and do NOT generate a REWRITE/ADD/DELETE item for it. Block findings are NEVER accepted via annotation — if you see an annotation trying to accept a block-tier finding, ignore the annotation and emit the block normally.
>
> {Insert the full audit criteria 3a through 3h from the "Audit criteria reference" section below}
>
> ## Defense-in-depth check (mandatory for every BLOCK candidate)
>
> Block tier means "test gives false confidence; a real regression could land green". A test isn't actually giving false confidence if 1+ sibling tests in the same file would catch the same regression — the regression would still fail in CI.
>
> For every BLOCK you're about to emit:
>
> 1. Identify the **specific regression** the flagged test SHOULD catch but doesn't (e.g. "removing the `usePageTracking()` invocation", "calling `removeItem('wrong_key')`", "skipping validation").
> 2. Search the rest of the test file for sibling tests that would catch the same regression. Look for: assertions on the same mock function with the same arg shape, assertions on the same observable side-effect, structural tests that exercise the same code path.
> 3. Fill the `COVERAGE:` field with line numbers of those siblings (e.g. `COVERAGE: L90, L102, L111`). If genuinely no sibling catches the regression, write `COVERAGE: none`.
>
> The main agent uses `COVERAGE:` to deterministically demote BLOCK findings whose regressions are already defense-in-depth covered (those become Catalog — recorded for context, not gating). `COVERAGE: none` means the BLOCK stands. Do NOT skip this field — a missing `COVERAGE:` is treated as a subagent compliance failure and the finding is held back for user review.
>
> ## Output format
>
> Return findings in EXACTLY this format. Omit any section that has no entries (write nothing — not "none"). No preamble, no summary, no commentary.
>
> ```
> AUDIT: {test_path} → {source_path}
> QUALITY: Good | Acceptable | Needs Work | Poor
>
> BLOCK:
> - [{type}] L{N}: {description} | CURRENT: {assertion} | SHOULD: {what to assert} | COVERAGE: {sibling tests in this same test file that already catch the same regression — list "L{N1}, L{N2}, ..." | "none" if no sibling catches it}
>
> IMPROVE:
> - [{type}] L{N} | RISK: {L}×{D}={score} | {description} | REGRESSION: {specific bug missed} | FIX: {one-line mechanical change}
>
> ACCEPTED:
> - [{type}] L{N}: {description} | RATIONALE: {rationale from the annotation}
>
> CATALOG:
> - [{type}] L{N}: {description}
>
> MISSING:
> - {scenario}
>
> KEEP:
> - {test name} L{N}
>
> REWRITE:
> - {test name} L{N} — {reason} | SHOULD: {what rewritten test asserts}
>
> ADD:
> - {scenario} — {why}
>
> DELETE:
> - {test name} L{N} — {reason}
> ```
>
> Keep each line under ~200 chars. Use short issue-type tags: `happy-path`, `mock-proving`, `weak-assert`, `missing-error`, `brittle`, `test-mismatch`, `untested-path`, `style`.
>
> **RISK score (improve only)**: `Likelihood × Detection-gap`, both 1–3.
>
> - **Likelihood (L)**: how likely the regression is to actually occur. 1 = pure-function refactor risk, 2 = active-development surface, 3 = sole guard against a known failure mode.
> - **Detection-gap (D)**: how much other coverage exists. 1 = defense-in-depth (other tests would catch it too), 2 = partial overlap, 3 = this is the only test that would catch the regression.
> - Highest scores (6, 9) sort first. Tied scores keep source order.
>
> **Hard rule on REWRITE / ADD / DELETE**: these three sections must correspond ONLY to BLOCK or IMPROVE entries. Never generate a REWRITE/ADD/DELETE item from a CATALOG entry — catalog is surfaced for the reader but does not drive downstream test-fix work.

After all subagents return, collect their structured outputs and proceed to Step 3.4.

#### Step 3b: Inline audit (single file pair)

Read both files directly and apply the same audit criteria (3a-3h). Produce findings in the same compact format. The same hard rule applies: REWRITE / ADD / DELETE entries must correspond only to BLOCK or IMPROVE — never CATALOG. Then proceed to Step 3.4.

---

### Audit criteria reference

These criteria are used by both Step 3a (included in subagent prompts) and Step 3b (applied inline).

**Quick reference**: which tier each criterion produces.

| Criterion        | Tier                                             |
| ---------------- | ------------------------------------------------ |
| 3a happy-path    | **block** (always)                               |
| 3b mock-proving  | **block** (always)                               |
| 3c weak-assert   | **improve** if the gate passes, else **catalog** |
| 3d missing-error | **block** (always)                               |
| 3e brittle       | **improve** if the gate passes, else **catalog** |
| 3f test-mismatch | **block** (always)                               |
| 3g untested-path | **improve** if the gate passes, else **catalog** |
| 3h style         | **catalog** (always)                             |

The **improve gate** (apply to 3c / 3e / 3g): all three of (1) mechanical fix, (2) names a specific regression, (3) <5 minutes. Failing any → catalog.

#### 3a. Happy-path-only coverage → block

The test file only tests successful scenarios and never tests:

- Invalid inputs / validation failures
- Missing or null data
- Unauthorized access
- Database/external service errors
- Boundary values (empty arrays, max lengths, zero, negative numbers)

**What to flag**: List the specific error/edge cases the source code handles that have NO corresponding test.

#### 3b. Mock-proving tests → block

Tests that only verify what was set up in the mock — they'd pass even if the code under test was deleted. Signs:

- The assertion checks a value that was directly returned by `mockResolvedValue()` with no transformation
- The test mocks a function, calls the code, and only asserts the mock was called (not what the code did with the result)
- No assertions about side effects, state changes, or return value transformations

**What to flag**: The specific test case(s) and what they should assert instead.

#### 3c. Weak assertions → improve (if gate passes) | catalog

Apply the **improve gate** before flagging:

1. **Mechanical fix?** Single-line replacement of one matcher / arg shape. If it requires restructuring the test or adding new fixtures → catalog.
2. **Names a specific regression?** You can write a one-line `REGRESSION:` describing the concrete bug current test would miss. "Could mask something" is not specific → catalog.
3. **<5 minutes to apply?** A junior dev with the file open could land it in a sitting. If reasoning about "what should the contract be" is needed → catalog.

Common improve-tier weak-asserts (gate usually passes):

- `.find(...).toBeDefined()` followed by accessing a property of `find()`'s result — failure message doesn't name the missing element. Fix: replace with a `getBy*` query that throws descriptively.
- `toHaveBeenCalled()` without args when one specific arg (user ID, path, event name) is the contract. Fix: add the arg.
- `expect(result).toBe(true)` on a function that returns structured data. Fix: assert the structured shape.
- Missing assertions entirely (test runs code but never checks results). Fix: add the post-condition.

Common catalog-tier weak-asserts (gate fails — DO NOT flag as improve):

- Partial-match `toHaveBeenCalledWith({ a })` when the missing keys are `undefined` — Vitest's undefined-key semantics mean `{ a }` equals `{ a, b: undefined }`. Gate fails on (2): no regression is masked. **Catalog only — do not propose an improve item even if other tests in the file use the full shape. Style consistency is not a regression.**
- `expect.objectContaining({ oneKey })` when the full shape is known but stable.
- `toBeDefined()` / `toBeTruthy()` where the specific value isn't contract-relevant.
- Assertions that check "more granular" behavior of something already covered by a broader assertion elsewhere.

#### 3d. Missing error path tests → block

Read the source code and identify all error conditions:

- `throw` statements
- Error responses (4xx, 5xx status codes)
- `catch` blocks
- Validation failures
- Auth/permission checks

Then check if each error condition has a corresponding test. Flag any that don't.

#### 3e. Brittle test structure → improve (if gate passes) | catalog

Apply the **improve gate** before flagging.

Common improve-tier brittleness (gate usually passes):

- Tests that depend on execution order (shared mutable state between tests). Fix: add `beforeEach` reset.
- Missing `beforeEach` cleanup / `afterEach` restore where setup leaks across tests. Fix: add the hook.
- Time-dependent hardcoded values (`Date.now()`, today's date, monotonic counters). Fix: freeze time with `vi.useFakeTimers`.
- Tests mocking internal implementation details rather than the boundary. Fix: re-mock at the boundary.

Common catalog-tier brittleness (gate fails):

- Manual `.mockRestore()` inside a test when `vi.restoreAllMocks()` in `afterEach` already handles it.
- Module-scope captures of values that happen to be correct for the current jsdom state.
- **Near-duplicate tests across describe blocks** — gate fails on (1): "delete one or differentiate them" is a judgment call about test intent, not a mechanical fix. Catalog and let the next author decide. **Do not propose deletion of tests as an improve item — the act of deleting "the duplicate one" creates a new audit surface for the next reviewer (which one was canonical?).**
- Mock factories using `as any` or broad types when the mock is only exercising a narrow surface.

#### 3f. Test-code mismatch → block

- Test describes behavior that doesn't match the source code (e.g., test name says "should return 404" but asserts 400)
- Test was written against an older version of the code and no longer tests the actual behavior
- Test mocks a dependency that the source code no longer uses

#### 3g. Untested code paths → improve (if gate passes) | catalog

Apply the **improve gate** before flagging.

Improve-tier (gate passes): an untested branch where the test can be added with one new `it(...)` block using the same fixtures and mocks the file already has, AND the branch covers a contract the source explicitly claims (validation, auth check, documented edge case).

Catalog-tier (gate fails): branches that need new test infrastructure (additional mocks, env stubbing, second test environment), or branches where it's unclear whether the test should exist (e.g. defensive `if` with no documented contract). **SSR guards or environment-only branches that jsdom can't exercise belong in catalog or accept-annotated, not improve.**

#### 3h. Style and nits → catalog (always)

Recorded in the per-file `### Catalog` section for context; never gates merge, never appears in `## Structured Findings`, never actioned by `/test-fix`.

Typical catalog entries:

- Shape-completeness preferences (partial matches where Vitest undefined-key semantics already hold)
- `@see` with absolute filesystem paths
- Cast expression style (`as unknown as X` vs `mockReturnValue(undefined)`)
- More-granular assertions on contracts already tested elsewhere
- Redundant manual `mockRestore()` when `afterEach` covers it
- Naming / comment drift
- Near-duplicate tests covering deliberate boundary cases

---

### Accept annotations

Improve items that represent intentional, conscious trade-offs (jsdom can't exercise a branch, a specific assertion shape is deliberately loose, etc.) can be marked as accepted in the test file. Subagents recognize these annotations and move the corresponding findings out of `IMPROVE:` into `ACCEPTED:`. **Accepting an Improve item satisfies the production-ready bar** — accepted findings count as resolved.

**Grammar**:

```ts
// test-review:accept <issue-type> — <rationale>
```

- `<issue-type>`: one of:
  - **Improve-tier tags** (used by `/test-review`): `weak-assert`, `untested-path`, `brittle`.
  - **Signature-hit keys** (used by `/test-triage`): `tobe_true`, `find_then_defined`, `no_arg_called`, `empty_not_throw`, `clear_then_notcalled`. Annotating a sig-hit means the regex match is a false positive for the green-bar pattern (e.g. `toBe(true)` on a structured return property like `isPending` is legitimate, not degenerate). Triage subtracts annotated matches from `sig_hits`.
  - **Block-tier types** (`happy-path`, `mock-proving`, `missing-error`, `test-mismatch`) — NEVER acceptable via annotation. Block tier means "test gives false confidence"; an annotation cannot dissolve that. Fix the test or document the source.
- Em-dash separator (`—`) required between the issue-type and the rationale. A plain `-` or `--` is tolerated but `—` is canonical.
- `<rationale>`: free text, mandatory. One line. Explain _why_ the finding is accepted (what makes it intentional, what the workaround would cost, etc.). "Known issue" is not a rationale.

**Placement**: immediately before the `it(...)` block, `it.todo(...)`, or specific `expect(...)` line it covers. Subagents scan ~10 lines backward from the flagged line to find a match.

**Examples**:

```ts
// test-review:accept untested-path — typeof window guard at user-identifier.tsx:64 unreachable in jsdom without a second test env
it.todo('should guard window access when window is undefined on authenticated-user path');
```

```ts
it('should render Plausible script with domain attribute', async () => {
  // ... setup ...
  // test-review:accept weak-assert — getAttribute on undefined would throw descriptively; find() scoped to data-domain-bearing elements only
  const plausibleScript = scripts.find((s) => s.getAttribute('data-domain'));
  expect(plausibleScript).toBeDefined();
  expect(plausibleScript?.getAttribute('data-domain')).toBe('example.com');
});
```

```ts
// test-review:accept tobe_true — isPending is a boolean field on the returned state object; assertion tests a structural property, not a degenerate "operation succeeded" check
expect(result.isPending).toBe(true);
```

**Matching rule**: a finding at line `N` is accepted if there is a `// test-review:accept <same-type> — ...` comment in the range `[N-10, N]`. Multiple types can be stacked across multiple comment lines. Proximity is the match key — no explicit source-ref required for v1. This rule applies to both `/test-review` Improve items AND `/test-triage` signature-hit matches.

**What is NOT acceptable to annotate**:

- `block` findings — never accept a test that gives false confidence. Fix or document the source.
- `catalog` findings — already not flagged as Improve, so no annotation needed.
- Whole-file blanket accepts — the proximity rule enforces specificity; a comment at the top of the file matches nothing.

**Surfacing**: accepted findings appear in the review's `### Accepted` subsection per file (visible for re-evaluation) and in the summary as `Improve: N (+M accepted)`. They do NOT appear in `## Structured Findings` — `/test-fix` ignores them. **Accepting an Improve item counts as resolved** for the production-ready bar. If an accepted finding later stops being intentional (e.g. a test env becomes available), remove the annotation and the next review flags it normally.

---

### Step 3.4: Re-filter findings (main agent, deterministic)

This step runs in the **main agent** after subagents return (or after the inline audit completes). It exists because subagents are subjective and sometimes emit orphan or weakly-grounded items. This step deterministically tightens every list so users get a bounded, consistent result.

Sub-steps 3.4a through 3.4d apply in order.

#### Step 3.4a: Block re-filter via COVERAGE field (with main-agent verification)

For each Block in each file's subagent output:

1. Parse the `COVERAGE:` field.
2. **`COVERAGE: none`** → keep as Block. Genuine sole-guard finding.
3. **`COVERAGE: L{N1}, L{N2}, ...` (one or more siblings)** → **verify before demoting** (do not trust the subagent blindly):
   - **a. Extract the regression target.** From the Block's `SHOULD:` field, pull out the mock function name OR observable side-effect that the regression would alter. Examples:
     - `SHOULD: expect(usePageTracking).toHaveBeenCalledTimes(1)` → target = `usePageTracking`
     - `SHOULD: assert removeItem('oauth_login_pending')` → target = `removeItem`
     - `SHOULD: assert page() not called` → target = `page` (or whatever variable holds the mock — `mockPage`, etc.)
     - If you cannot extract a concrete target from `SHOULD:`, treat the COVERAGE field as unverifiable and fall through to (e).
   - **b. Read the cited lines.** For each line `L{N}` in the COVERAGE list, `Read` the test file with `offset: max(1, N-8)` and `limit: 16`. This gives you the enclosing `it(...)` body without pulling the whole file into context.
   - **c. Verify each cited line.** A cited line verifies if the read range contains an `expect(...)` clause that mentions the regression target from (a). Substring match on the target token is sufficient — the subagent's claim is "this test would catch the regression"; presence of an assertion on the named mock/side-effect is the verification.
   - **d. All cited lines verify** → demote to Catalog with note `weakly framed; regression "{target}" covered by sibling tests at L{N1}, L{N2} — defense-in-depth holds (verified), not gate-blocking`.
   - **e. Any cited line fails to verify** (line range contains no `expect(...)` mentioning the target, or line number doesn't exist in the file) → **keep as Block** and flag in main agent's chat output: `COVERAGE verification failed for {file}:{line} — subagent cited L{N} but no assertion on "{target}" found in surrounding it block; treating as gate-blocking. Re-check the test file or rewrite the flagged test.`
4. **Field missing entirely** (subagent compliance failure) → keep as Block but flag in main agent's chat output: `Subagent omitted COVERAGE field for {file}:{line} — review manually before treating as gate-blocking`.

Track verified-vs-failed COVERAGE counts separately for the chat summary in Step 5.

**Why verify:** Subagents fabricate occasionally — citing a line number that doesn't exist, or pointing at a test that doesn't actually assert on the regression target. Without verification, a fabricated COVERAGE field would silently demote a real Block. The verification cost is small per Block (1–3 narrow file reads); the safety upside is large (no false-confidence demotions). The trade-off in main-agent context use is deliberate.

The defense-in-depth principle: if the regression a Block claims to catch is already caught by sibling tests in the same file, the regression cannot land green in CI. The Block is a real test-quality observation but not a false-confidence gap. **Verification ensures this principle is grounded in real assertions, not subagent hallucinations.**

#### Step 3.4b: Improve re-filter via gate (existing rules)

For each file's Improve list, re-apply the gate by walking the items and asking each one:

1. **Mechanical fix?** Is `FIX:` a single-line, single-pattern change? If it requires reasoning ("decide which to keep", "rethink the assertion shape"), demote to Catalog.
2. **Names a specific regression?** Does `REGRESSION:` describe a concrete bug (wrong arg, missing arg, wrong path, missing branch)? "Inconsistent with sibling tests", "drift risk", "could mask something" are not specific. Demote to Catalog.
3. **<5 minutes?** Implied by (1) — if (1) passes, this passes too.
4. **Specific demote rules** (apply mechanically, no judgment needed):
   - Any improve with type `weak-assert` whose `FIX:` is "align partial-match `toHaveBeenCalledWith({a})` to `{a, b: undefined}` because other tests use full shape" → demote. Vitest treats `{a}` and `{a, b: undefined}` as equal — no regression masked, only style drift.
   - Any improve with type `brittle` whose `FIX:` is "delete duplicate test" or "differentiate near-duplicates" → demote. Choosing which test is canonical is a judgment call, and deletion creates new audit surface for the next reviewer.
   - Any improve whose `REGRESSION:` line uses the words "drift risk", "inconsistent with siblings", "consistency", or "alignment" without naming a behavioural regression → demote.
5. **RISK Detection-gap reality check**: if `RISK` has D=3 (sole guard) but the subagent's `REGRESSION:` plausibly describes a regression that another test in the file would also catch, downgrade RISK to D=1 mentally and re-evaluate priority. (This step is a soft heuristic; it doesn't demote, it only affects the cap in 3.4d.)

#### Step 3.4c: Drop orphan REWRITE / ADD / DELETE entries

The hard rule says REWRITE / ADD / DELETE must correspond ONLY to BLOCK or IMPROVE entries. Subagents sometimes ignore this rule (e.g. emitting an ADD from a MISSING entry without an underlying BLOCK or IMPROVE).

For each REWRITE / ADD / DELETE entry in each file:

1. Check whether there is a BLOCK or IMPROVE entry at the same line number (REWRITE/DELETE) or referencing the same scenario (ADD).
2. If yes: keep.
3. If no: **inspect the orphan**. If the underlying observation is a real gate-passing IMPROVE the subagent misclassified (mechanical fix, names a regression, <5min — same gate as 3.4b), promote it: add a corresponding IMPROVE entry to the file's Improve list with a note `(promoted from misclassified MISSING/ADD)` and keep the structured-finding entry. Otherwise: drop the orphan with note in main agent's chat output: `Dropped orphan {REWRITE|ADD|DELETE} for {file}:{line} — no corresponding BLOCK or IMPROVE source. {one-line reason it doesn't meet the gate.}`

#### Step 3.4d: Per-file Improve cap

After 3.4a-3.4c, if any single file still has more than 5 Improve items remaining, sort that file's items by RISK score (descending) and demote everything below the top 5 to Catalog with the note `(over cap — see top 5 first)`. The cap exists to keep `/test-fix` execution bounded and force prioritization; users can re-review after the top 5 land if they want more.

Output: updated per-file Block, Improve, and Catalog lists. Track demote counts separately by source rule (gate, COVERAGE, orphan, cap) for the chat summary.

### Step 3.5: Surface source findings linked to Block-tier test issues

This step runs in the **main agent** (not subagents) — it requires cross-file reasoning and judgment about source intent.

**Read sparingly.** Work from subagent evidence where possible (each subagent cites source line numbers and described behavior). Only `Read` a source file if you genuinely cannot classify the finding from the subagent output — e.g., the subagent flagged a "mock-proving" block but you need to see the source line to confirm whether it's a real gap or an intentional no-op. When you do read, read only the relevant range, not the whole file.

Mock-proving tests and similar Block-tier findings almost always sit on top of a real source gap. The test is "green" because the test was bent to fit the source, not the other way round. For every Block-tier test finding raised in Step 3 (whether from subagents or inline), ask:

> **If this test were rewritten honestly against the source, would it pass?**

If the answer is no, the source has a gap — record it as a **Source Finding**, separate from the test rewrite. (Improve-tier findings do NOT generate Source Findings — they are about test quality, not source contracts.)

For each source finding, pick a default classification (see `.claude/docs/test-command-file-protocol.md` for the full vocabulary):

- **Fix** (default): Source is genuinely broken. Pick this for unhandled rejections, missing validation at security boundaries, silent catch-all blocks, logic that contradicts documented intent. The fix is usually small (add `.catch()`, wrap in try/catch, add a validation check).
- **Document**: Source behavior is intentional but undocumented. Pick this when the function is meant to throw, or when the "gap" is really a deliberate no-op.
- **Skip**: The test was testing the wrong thing. Pick this when the test asserts a contract the source never claimed.

Default to **Fix** unless you have specific evidence that the behavior is intentional. Silent green-bar tests are the worse failure mode; a confident Fix default pushes the user toward honest test coverage.

Every source finding must link to the related test rewrite item(s) — they share a root cause.

Every finding is written with `Decision: {default}` and `Status: pending`. The review file is the authoritative decision-tracking record: the user resolves findings inside this conversation (inline fix, delegated subagent, or separate session — then "sync the review"), and the main agent updates the file's Status fields in-place (see Step 7). `/test-plan review` refuses to proceed until every finding is `resolved` or `accepted`.

### Step 4: Write full findings to file

Write the complete review to `.claude/tmp/test-review.md`, overwriting any prior run. This file is the authoritative record — `/test-plan review` reads from it. Follow the shared protocol in `.claude/docs/test-command-file-protocol.md` — every file must start with the metadata frontmatter block.

Before writing, capture git state with Bash:

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
date -u +%Y-%m-%dT%H:%M:%SZ
```

The file format:

```markdown
---
command: test-review
scope: {scope string — e.g., "components/analytics" or "branch diff vs origin/main"}
mode: targeted | branch-diff
branch: {current branch}
head: {current HEAD SHA}
generated: {ISO 8601 UTC timestamp}
---

# Test Quality Review

**Files reviewed**: {count} test files for {count} source files

## Summary

- **Block**: {count} — tests give false confidence, must fix before merging
- **Improve**: {count} ({accepted count} accepted, {demoted count} demoted by main-agent re-filter) — recommended fixes; mechanical, named regression, <5 min each. Accepted items are conscious trade-offs annotated in the tests and count as resolved.
- **Catalog**: {count} — recorded for next reviewer's context, NOT actioned by `/test-fix`
- **Source findings**: {count} — suspected source gaps linked to Block-tier test issues ({fix count} Fix, {doc count} Document, {skip count} Skip)

**Production-ready**: Yes / No

- **Yes** when: 0 Block AND every Improve item is either fixed or accept-annotated AND 0 pending source findings.
- Catalog never gates merge. Run `/test-fix {scope}` to apply Block + Improve items, then ship.

---

## File: `{test file path}` → `{source file path}`

**Overall quality**: Good / Acceptable / Needs Work / Poor

### Block

1. **{Issue type}** (line {N}): {description}
   - **Current**: `{the weak/wrong assertion or missing test}`
   - **Should be**: `{what should be tested instead}`

### Improve

(Sorted by RISK score, highest first. Each item meets all three gates — mechanical, named regression, <5 min.)

1. **{Issue type}** (line {N}) — RISK {L}×{D}={score}
   - **Regression missed**: {one line — concrete bug current test wouldn't catch}
   - **Fix**: `{one-line mechanical change}`

### Accepted

{Only included if this file has one or more `// test-review:accept` annotations that matched a would-be Improve item. Omit the subsection entirely if none.}

1. **{issue type}** (line {N}): {description}
   - **Rationale**: {the annotation's rationale text, verbatim}

### Catalog

(Recorded for context. Not actioned. Includes everything subjective: style, near-duplicates, demoted Improves, partial-match patterns.)

1. **{issue type}** (line {N}): {description} {if demoted by re-filter: " — demoted: {reason}"}

### Missing Test Cases

- [ ] {description}

---

{repeat for each file}

## Source Findings

Suspected source gaps linked to critical test issues. This section is the authoritative decision-tracking record — each finding carries a `Decision` (default: Fix) and `Status` (starts: pending). `/test-plan review` refuses to run until every finding is `resolved` or `accepted`.

### `{source file path}:{line}` — {one-line summary}

**Linked test item(s)**: `{test file path}:{line}` — `{test name}` (+ any siblings in the same Rewrite cluster)
**Decision**: Fix (default) | Document | Skip
**Status**: pending
**Reasoning**: {one short paragraph — what the source actually does today, what the contract should be, why this classification}
**If Fix**: {concrete source change — e.g. "add `.catch(logger.error)` on line 81", "wrap `sessionStorage.getItem` in try/catch returning null"}
**If Document**: {what the test should assert instead — the honest current behavior}
**If Skip**: {which test(s) to delete and why no replacement is needed}

---

{repeat for each source finding}

## Structured Findings

Consumed by `/test-plan review` and `/test-fix`. **Only BLOCK + IMPROVE entries appear here** — CATALOG items stay in the per-file `### Catalog` section above and are NOT actioned by the plan/fix commands. Catalog items are recorded for the next reviewer's context only.

### `{source file path}` → `{test file path}`

**Keep**:

- `{test name}` (line {N})

**Rewrite**:

- `{test name}` (line {N}) — {reason}. Should: {what the rewritten test should assert}. {If linked to a source finding: `Linked source finding: {source path}:{line}`}

**Add**:

- {scenario description} — {why}

**Delete** (optional — only if truly redundant):

- `{test name}` (line {N}) — {reason}

---
```

### Step 5: Print terse summary to chat

Do NOT print the full review in chat. Print a short, scannable summary only — the user can open the file if they need details.

Format:

```
## Test Quality Review — {scope}

{N} files reviewed · **{B} block · {Im} improve ({A} accepted, {D} demoted) · {C} catalog** · **{S} source findings ({Fix}/{Doc}/{Skip})**
{If parallel mode: "Audited via {N} parallel Sonnet agents + Opus re-filter and source analysis"}
{If any 3.4 demote source fired, add a one-line breakdown: `Demoted: {Dgate} via gate · {Dcoverage} via Block COVERAGE (verified) · {Dorphan} orphan structured findings · {Dcap} over per-file cap`. Omit zero entries.}
{If 1+ subagents omitted COVERAGE: `Subagent compliance: {N} BLOCK finding{s} missing COVERAGE field — listed below for manual review`. List them.}
{If 1+ COVERAGE claims failed verification in 3.4a: `COVERAGE verification: {N} BLOCK finding{s} kept as gate-blocking because subagent's cited line(s) didn't contain a matching assertion — listed below`. List them with the specific cited line and the missing target.}
Full findings: `.claude/tmp/test-review.md`

| File | Quality | Block | Improve | Accepted | Catalog |
|------|---------|-------|---------|----------|---------|
| {filename} | {Good/Acceptable/Needs Work/Poor} | {count} | {count} | {count} | {count} |
{...one row per file}

### Top Block findings
{Up to 5 one-liners, highest-impact first. Format: `file.test.tsx:NN — {issue type}: {one-sentence why}`}
{If 0 Block: omit this section and write "No Block findings."}

### Top Improve findings (by RISK)
{Up to 5, sorted by RISK score descending: `- file.test.tsx:NN — RISK {L}×{D}={s}: {regression missed}`}
{If 0 Improve: omit entirely}

### Source findings ({S})
{Up to 3 highest-impact, one per line: `- source/path.ts:NN — {default classification}: {one-sentence why}`}
{If 0: omit section entirely}

**Production-ready**: {Yes / No}
{If No: list which gates fail — e.g. "{B} Block must fix · {Im - A} Improve unresolved · {S} source findings pending"}
{If Yes: "All gates clear — ship via `/pre-pr` when ready."}

{If 0 source findings AND (B + Im - A) > 0:}
Next: `/test-fix {scope}` to apply Block + Improve in one pass.

{If 1+ source findings:}
Next: resolve the {S} source finding{s} first — see options below. Once every finding is `resolved` or `accepted`, run `/test-fix {scope}`.

{If production-ready:}
Next: `/pre-pr` for final validation, then ship.
```

Keep it under ~24 lines of chat output regardless of how many files were reviewed. If there are more than 5 findings in any tier, show the top 5 and note "(+{N} more in file)".

### Step 6: Offer next action

After the summary, branch on (a) source findings and (b) whether anything actionable remains. The goal is to keep decision-making **here in this conversation** — do not punt while findings are still pending. **`/test-fix` is the default fast path** for 1–5 files; it consumes this review file directly.

#### If production-ready (0 Block, 0 unresolved Improve, 0 source findings)

> Production-ready. Catalog items recorded for future context but won't gate merge.
>
> Next: `/pre-pr` for final validation, then ship.

#### If 0 source findings, but Block or Improve remain

Branch on **how many files have at least one Block or unresolved Improve** (call this `F`). The two paths converge — both run the test-engineer agent, the difference is batching strategy.

**If `F` ≤ 5 (small scope, single-pass):**

> Next: `/test-fix {scope}` applies the {B} Block + {Im - A} Improve items in one pass. Validation (lint + type-check + tests) is the convergence signal — no re-audit needed unless source changes or `/pre-pr` flags net-new issues.

**If `F` ≥ 6 (folder cleanup or multi-file scope):**

> Next: `/test-plan review {scope}` → `/test-write plan`. `/test-fix` refuses 6+ files in one pass because a single agent shouldn't own that much context. The plan step phases the work into sprints with parallel agents per sprint; `/test-write plan` executes them.
>
> _(`/test-fix` would refuse with the same message — no point routing through it.)_

#### If 1–3 source findings

The right move is usually a small inline fix. List the findings with the `If Fix` recommendation and offer to apply them:

> {S} source finding{s} need a decision before fixes can run. Defaults are **Fix** — small changes I can apply inline right now:
>
> - `{source path}:{line}` — {one-line summary of the If Fix change}
> - ...
>
> Options:
>
> - Say **"fix them"** (or name specific ones) to apply the default Fix now.
> - Say **"document {finding}"** or **"skip {finding}"** to override the default and accept as-is.
> - Say **"I'll handle these separately"** to fix externally, then come back and say **"findings are fixed"** or **"sync the review"** so I verify and update statuses.
>
> Once every finding is `resolved` or `accepted`, run `/test-fix {scope}`.

#### If 4+ source findings OR any individually complex fix

Inline resolution stops scaling. Recommend external handling with a sync-back:

> {S} source findings need a decision — too many to resolve cleanly inline. Recommended flow:
>
> 1. Handle the fixes externally — a dedicated session, a subagent sweep, or your editor. The review file at `.claude/tmp/test-review.md` has the full `If Fix` recommendation for each finding.
> 2. Optionally override defaults first — say **"document {finding}"** or **"skip {finding}"** for any you want to accept as-is.
> 3. When the fixes land, come back and say **"findings are fixed"**. I'll re-read the affected source ranges and update the review's Status fields.
>
> Once every finding is `resolved` or `accepted`, run `/test-fix {scope}`.

---

#### Re-audit policy (do NOT propose `/test-review` again by default)

This command is the entry point for an audit cycle, not the validation step inside one. After `/test-fix` runs, lint + type-check + tests passing IS the validation signal. Only suggest re-running `/test-review` when one of:

- **Source changed** since this review (frontmatter `head` differs from `git rev-parse HEAD`).
- **User explicitly asks** for a re-audit.
- **`/pre-pr` flags net-new issues** that didn't exist in this review.

Reflexively suggesting another `/test-review` after `/test-fix` is the loop trap that cost the user a fortune in tokens — every fix creates new audit surface (split tests, aligned tests, deleted tests). Trust the validation chain instead.

### Step 7: Resolve findings (respond to inline fix / sync requests)

This step runs when the user asks you to apply, accept, or verify source findings after the review has been written. The trigger phrases cluster around:

- **Apply defaults**: "fix them", "fix {finding name}", "apply the fix", "do the inline fixes"
- **Override defaults**: "document {finding}", "skip {finding}", "accept {finding} as document/skip"
- **Sync after external work**: "findings are fixed", "sync the review", "check the fixes", "I've fixed {finding}"

Always work from `.claude/tmp/test-review.md` — re-read it to get the current state of every finding's `Decision` and `Status` before acting.

#### 7a. Apply inline fixes (Decision = Fix, user says "fix them")

For each finding the user asked to fix:

1. Read the source range referenced in the finding's `If Fix` line (narrow range — just enough to make the change). This is the Step 3.5 carve-out; reading the whole file is unnecessary.
2. Apply the change using `Edit`. If the fix requires a new import (e.g. `logger`), add it too.
3. Run `npm run type-check` and `npm run lint` scoped to the changed file. If either fails, report and stop — do not flip status until the fix is clean.
4. Update `.claude/tmp/test-review.md`: flip that finding's `Status: pending` to `Status: resolved`. Leave `Decision: Fix` as-is.
5. Move to the next finding. After all requested fixes are applied, print a short summary.

#### 7b. Accept overrides (Decision = Document or Skip)

The user has chosen to not change the source. For each finding being overridden:

1. No source read or change needed — this is a classification flip.
2. Update `.claude/tmp/test-review.md`: change that finding's `Decision` from `Fix` to `Document` (or `Skip`) and flip `Status: pending` to `Status: accepted`.
3. The review's `Structured Findings` block still references the finding's test items — those will be handled by the plan/write steps according to the new Decision (Document → assert honest current behavior; Skip → delete test).

#### 7c. Sync after external fixes (user says "findings are fixed")

For each `pending` finding with `Decision: Fix`:

1. Read the source range referenced in the `If Fix` line.
2. Verify the fix matches the recommendation — concretely:
   - "Add `.catch(logger.error)` on line 81" → confirm a `.catch(...)` handler is now present at/near that line and `logger` is imported.
   - "Wrap X in try/catch returning null" → confirm a `try`/`catch` block is present around the call.
   - Match is semantic, not syntactic — if the fix uses a different logger method or a different variable name but achieves the same contract, accept it.
3. If verified: flip `Status: pending` to `Status: resolved`.
4. If NOT verified: leave `Status: pending` and record a short note in your summary — e.g., "line 81 still has `void initialize()` with no catch handler; fix not detected". The user can either land the fix or explicitly accept a Document/Skip override.
5. If the user also overrode some findings (Document/Skip), apply those per 7b at the same time.

#### 7d. Report after any Step 7 action

Print a compact summary:

```
Review sync — `.claude/tmp/test-review.md` updated:
- resolved: {N} ({list})
- accepted: {N} ({list})
- still pending: {N} ({list with reason})

{If 0 pending:}
All source findings resolved. Next: `/test-fix {scope}` to apply Block + Improve in one pass.

{If >0 pending:}
Remaining findings need attention before `/test-fix` can run. See options from Step 6.
```

Keep it under 10 lines. The review file itself has the full detail.
