# Writing a check that can fail

Every automated check in this repo answers a question, and every one of them has
a second answer it must never confuse with the first:

|                                  |              |
| -------------------------------- | ------------ |
| **"I looked and found nothing"** | a result     |
| **"I could not look"**           | not a result |

Printed side by side that looks obvious. It has been the cause of more shipped
defects here than any other single mistake, because the two produce **identical
output**: silence, a zero, an empty list, a green tick.

This page is the checklist that would have caught them.

> Instances below cite
> [#651](https://github.com/human-centric-engineering/sunrise/pull/651), which is
> open at the time of writing. The lesson does not depend on it merging — the
> defects were real and were found before it shipped.

## The distinction is already the house style — that is not the hard part

19 of the 20 scripts under `scripts/ci/` already carry explicit "could not
read / could not run" handling (`check-prisma-format.ts` is the one that does
not), and `check-missing-tests.ts` states the contract
outright: _exit codes say only whether the check could run._ So a check that has
no could-not-look path at all is rare.

**Every defect in the record below was written by someone who had already
implemented that distinction — for one channel, while three existed.** That is
the actual failure mode, and it is why "remember to handle the error case" is
not sufficient advice.

## The channels

Work through these when writing or reviewing a check. Each one is a way to
produce a clean-looking result without having looked, and each has a real
instance in this repo.

### 1. The input set was empty

The glob matched nothing, the file list was truncated, the path was typo'd, the
directory does not exist.

- **`fix:dom-tests` ([#651](https://github.com/human-centric-engineering/sunrise/pull/651))** — a mistyped target made vitest exit 1 with
  `numTotalTestSuites: 0`. Every bucket came back empty and the tool printed
  "No failure was caused by a missing browser global" and exited **0**, having
  run nothing at all.
- **CI change detection** (`ci.md`) — a short file list means gates that never
  ran, and a skipped job passes. The truncation flag defaults to `true` and is
  cleared only by a positive numeric match.
- **`check-missing-tests.ts`** — an empty `tests/` index is "could not look",
  not "nothing to find"; it exits 1 rather than reporting every file as missing.

**The move:** assert the input is non-empty _before_ trusting the output, and
say so in the assertion — `expect(TEST_FILES.length).toBeGreaterThan(900)` in
`tests/unit/vitest-environment-directives.test.ts` is there for exactly this.

### 2. The tool errored but still produced parseable output

A non-zero exit with a well-formed empty report is the worst case, because the
parse succeeds.

- **#651 again** — the JSON report parsed fine. It just described nothing, so
  every downstream count was legitimately zero.

**The move:** read the tool's own count fields, not only the shape of its
output.

### 3. The output parsed but was not the shape you expected

- **#651's report reader** returns `null` for an unrecognised report and an
  empty list for "ran, nothing failed". Collapsing those two would let an
  unreadable report print `0 files need a DOM`.

**The move:** make the type carry the difference. An `Array | null` where `null`
means "could not look" is cheap; a bare array is not able to say it.

### 4. Verification tested for absence rather than presence

The subtlest one, and it survived a security review and a code review before
being caught.

- **#651** confirmed its own edits by checking each file was
  **absent from the failure list**. A re-run that executed nothing therefore
  "confirmed" every edit. Absence is not evidence: a file missing from a report
  may simply not have run. It now requires **presence in the passed list**.

**The move:** when you verify something worked, assert the positive fact.

### 5. The matcher stopped matching

The check runs, greps, finds nothing, reports clean — because the pattern no
longer matches anything, not because the tree is clean.

- **#641** — a `compgen -G` loop (a bash builtin) in a zsh agent shell printed
  nothing and was nearly banked as a clean tree. This is the incident that
  started the whole line.
- The **sentinel** answer: run the classifier over synthetic known-bad input
  before every real scan, and refuse to report if it comes back clean.
  `selfTestFailure()` in `missing-tests.ts` and `scoped-tests.ts`, with their
  CLIs running it before every real scan. **4 of 20 scripts do this** — it is
  the newest of these conventions by some distance, not an established one, and
  the 16 without it are deliberately not being retrofitted here. Reach for it
  when a check's answer depends on a matcher that could stop matching.

**The move for a prose check in `/pre-pr`:** plant a known-bad sentinel, confirm
the scan flags it, remove it, then run for real. And never write `|| echo CLEAN`
— `grep` exits 1 when it ran and found nothing, and 2 when it could not run.

### 6. A skipped or cancelled step read as success

- **`ci-status`** used to test for the literal string `failure`, which let
  `cancelled` through — a job killed by its own timeout reported "CI passed".
  It is now an **allow-list** (`success` or `skipped`), not a deny-list.
- **The scoped test runner (#647)** — an empty selection must not reach
  `vitest run` with no filters, because that runs the _whole_ suite. "Nothing to
  run" and "run everything" are one typo apart.

**The move:** allow-list the outcomes you accept. Enumerating the bad ones means
the next new state is silently good.

## What this does not ask for

Not every check needs a sentinel and a five-way exit code. A check whose input
is a single named file, read directly, has one way to fail and it is loud.

The question to ask is narrower: **list the ways this check could report success
without having examined anything.** If that list has one entry, handle it. If it
has three — which is where all the defects above came from — handle three.

## Related

- [`ci.md`](./ci.md) — change detection, the 3000-file cap, `ci-status`'s allow-list
- [`.context/testing/scoped-runs.md`](../testing/scoped-runs.md) — the always-run
  list, and why a module-graph selector cannot see a whole-tree test
- [`.context/testing/environments.md`](../testing/environments.md) — the
  asymmetry between a loud failure and a silent pass
- `scripts/ci/missing-tests.ts` — the fullest worked example of the contract
