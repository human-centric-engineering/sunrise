# Scoped test runs

How to run the tests a branch actually needs, why that is the local default,
and the one thing the scoping cannot see.

## The commands

| Command                         | Runs                                             | Coverage                            |
| ------------------------------- | ------------------------------------------------ | ----------------------------------- |
| `npm run test:changed`          | tests affected by the branch + whole-tree guards | none                                |
| `npm run test:changed:coverage` | same                                             | changed source files, ≥80% **each** |
| `npm run test`                  | the whole suite                                  | none                                |
| `npm run test:coverage`         | the whole suite                                  | whole repo, ≥80% overall            |

`/pre-pr` step 1 runs `test:changed:coverage`. The full-suite scripts are
unchanged and still there for when you want them.

Both scoped commands forward any flag they do not recognise to vitest. npm eats
the first `--` itself, so these work as written — an earlier version required a
separator that never survived npm and dropped the flag in silence:

```bash
npm run test:changed -- --reporter=dot        # unknown flags reach vitest
npm run test:changed:coverage -- --bail=1
npx tsx scripts/ci/run-scoped-tests.ts --dry-run     # print the plan, run nothing
npx tsx scripts/ci/run-scoped-tests.ts --base HEAD~3 # a base other than the merge base
npx tsx scripts/ci/run-scoped-tests.ts --no-fetch    # skip the origin/main fetch
```

## What gets selected

Two sets, unioned:

1. **What `vitest --changed <merge-base>` selects** — every test whose import
   graph contains a changed file. Uncommitted and untracked work counts; this
   runs before a commit far more often than after one.
2. **`ALWAYS_RUN_TESTS`** — tests whose subject is the repository rather than a
   module, listed in `scripts/ci/scoped-tests.ts`.

They are unioned by the runner rather than handed to vitest together, because
vitest **intersects** positional filters with `--changed` — asking it for both
in one invocation returns neither.

### Why the always-run list exists

`tests/unit/lib/privacy/export-sources.test.ts` reads `prisma/schema/*.prisma`
off disk and fails until every model with a user FK appears in the export
manifest. Nothing imports the schema, so no module graph connects the two, so
`--changed` will never select that test no matter which model you add. Same
shape for the reserved-namespace rule, the fork-init seam roster, the
outbound-redirect roster, and the ESLint app-boundary check.

Those are the checks this repo leans on hardest. A scoped run that silently
stopped running them would be the "skipped gate reads as green" failure
[`.context/architecture/ci.md`](../architecture/ci.md) spends a section on.

### Why the list is written and not derived

Three detectors were tried against this tree, and each one missed a different
group. Counts measured at `8167a36f`, the base this landed on — they drift as
tests are added, and the misses are the point rather than the totals:

| Rule                              | Found | Misses                                   |
| --------------------------------- | ----- | ---------------------------------------- |
| by fs API name                    | 22    | 3 that import fs under an alias          |
| by `node:fs` / glob import        | 16    | 9 that mock `node:fs` or go via a helper |
| by read rooted at `process.cwd()` | 14    | `tests/unit/eslint-app-boundary.test.ts` |

That last miss is the point: it reads the whole tree through ESLint's own file
resolution and imports no filesystem module at all. It is a real member of the
list that no static rule proposed. Deriving a roster that must not miss
anything, from a signal that demonstrably misses things, is how a check ends up
unable to fail.

So the list is hand-written with a reason per entry, and
`undeclaredRepoRootedTests` is **advisory**: it prints tests that read from the
repo root and are not declared, as a prompt to consider them. It matches its
patterns anywhere, including inside string literals, so a test whose _fixtures_
are snippets of tree-reading code reports itself — `run-scoped-tests.test.ts`
does. A clean advisory means "nothing new matched two patterns", never "the list
is complete".

**Adding to the list.** A new test that asserts something about the repository —
file layout, a manifest against the schema, a roster of call sites — goes in
`ALWAYS_RUN_TESTS` with a concrete reason. "Reads the tree" is not a reason;
"parses `prisma/schema/*.prisma`" is. The reason is what tells the next person
whether their test belongs there.

## Coverage, scoped

`--coverage.include` is limited to the changed source files and
`thresholds.perFile` puts the 80% floor on each of them individually.

This is a different question from the one the old full-suite gate asked. A
project-wide 80% average clears comfortably while a newly added file sits at 0%;
per-file, that file fails. A changed file with no test at all is reported **as
0%**, not omitted, which removes the ambiguous "no coverage data" category the
report used to have.

`vitest.config.ts`'s own `coverage.exclude` still wins over a CLI
`--coverage.include` (verified against vitest 4.1.10), so layouts, `lib/env.ts`,
`types/**` and the rest stay exempt without a second exclusion list here to
drift from the config.

### The floor lands on what you authored, not on what a merge brought in

Selection and the floor deliberately use **different** file lists. Selection
uses the whole diff, because a merge really can break upstream's tests and
those should run. The floor uses only what the branch authored — commits on its
own first-parent line, excluding merges, plus staged and working-tree files.

This is what a sync merge needs (#671). The floor asks "is what you changed
tested", and on a sync merge a fork changed nothing: every file in the diff was
written upstream. Holding it to the floor left a fork choosing between failing
its own gate and writing tests for platform code
[`CUSTOMIZATION.md`](../../CUSTOMIZATION.md) asks it not to diverge on. Measured
against v0.11.0, that was 6 files for a fork syncing from v0.9.0, ~15 from
v0.7.0 and ~16 from v0.5.0 — the cost grows with distance from the fork point.

An ordinary feature branch has no merges, so it is gated exactly as before. When
the two counts differ the run prints `not authored here N`, because a floor that
quietly stops applying reads the same as one that passed.

**The trade-off, stated:** writing code on one branch and merging it into
another before opening the PR moves those files out of the floor's reach. That
is deliberate evasion rather than an accident, `test-full` still runs the whole
suite in CI, and the alternative was a gate that is wrong for every fork on
every sync.

### Coverage debt is invisible from a full run

A file no test imports is **absent from `npm run test:coverage` altogether** —
not reported at 0%, simply not there. It only materialises when a scoped run
forces it in with `--coverage.include`. That is why `scripts/ci/check-client-env-delivery.ts`
and `scripts/db/check-drift.ts` reached a fork's sync merge without upstream
ever seeing them, and why CLI entrypoints that talk to a live database or
provider are excluded in `vitest.config.ts` by name rather than left to sit at
an unowned 0%.

Measured at the time of writing: **76 files** in the tree are below the per-file
floor on at least one metric. Upstream's own gates do not surface them, because
`test:coverage` gates on the repo average and `test:changed:coverage` only sees
what a branch touched.

## What a scoped run does not tell you

**That the branch broke nothing elsewhere.** A test outside the changed files'
import graph is not selected, and no always-run entry covers "some unrelated
thing I did not think about". CI's `test-full` job is the backstop, and it is
what makes a hand-maintained always-run list an acceptable risk rather than a
load-bearing one.

**Read that backstop carefully if your fork sets `CI_TEST_SCOPE=changed`.** With
the default (`full`), `test-full` runs the whole suite 4-way sharded on every PR
and every push to `main`, and the claim above holds. Set it to `changed` and
`test-full` is skipped on PRs (`ci.yml`: `test_scope != 'changed' || event_name
== 'push'`) — the whole suite then runs only _after_ merge, on the push to
`main`. The `test-changed` job that replaces it runs a bare
`npx vitest run --changed`, **without the `ALWAYS_RUN_TESTS` union**, so on such
a fork a PR adding a model with a user FK passes CI while
`export-sources.test.ts` never runs.

Closing that is a one-line change to the `test-changed` job:

```yaml
- run: npx tsx scripts/ci/run-scoped-tests.ts --base ${{ github.event.pull_request.base.sha }} --no-fetch
```

Sunrise itself leaves `CI_TEST_SCOPE` at `full`, so the job is inert upstream
and the change is left to the forks that actually switch it on.

Run the full suite locally when:

- you have merged `main` into the branch — scoped runs hide regressions in the
  tests that merge brought in
- you are cutting a release
- the branch touches something central, in which case the scoped run is nearly a
  full one anyway (`lib/env.ts` selects 518 of 1081 test files at 8167a36f;
  `lib/logging/index.ts` selects 642)

## Failure modes worth recognising

| Output                                       | Means                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Could not run — no base revision available` | `origin/main` is missing or unfetchable. Exit 1, **not** a pass.                                       |
| `Could not fetch origin/main`                | Offline. The run continues against the local ref, which may be behind.                                 |
| `vitest list … failed`                       | The selection is unknown, so the run is refused rather than partial.                                   |
| `always-run entry not found in this tree`    | A listed test was renamed or deleted. Fix the list with a reason.                                      |
| `terminated by SIGKILL`                      | Usually OOM. Exit 1 — a killed run is not a passed one.                                                |
| `printed N line(s) that are not files`       | Every line is prefixed — you have a vitest `projects` config, which this runner does not support.      |
| `nothing to run`                             | Nothing was selected and no always-run test exists. Exit 0, and deliberately **not** a full-suite run. |

The stale-base case is the one to take seriously. A stale base produces a short
changed-file list, a short list produces a small selection, and a small
selection passes quickly — the failure looks exactly like success. That is why
the runner fetches `origin/main` by default and exits 1 rather than guessing.

## For forks

`ALWAYS_RUN_TESTS` is append-only from a fork's point of view: add your own
whole-tree invariants, and upstream changes stay merge-clean because Sunrise
only ever adds entries of its own. If you delete one of Sunrise's tests, remove
its entry too — the runner warns about an entry it cannot find rather than
skipping it quietly, so it will tell you.

**On a sync merge**, `npm run test:changed:coverage` runs every test the merge
can affect but holds only your own files to the 80% floor, so a clean sync
passes without you writing tests for Sunrise's code. Files you author in the
same branch as the merge are still gated — the exemption follows authorship,
not the presence of a merge.

## See also

- [`overview.md`](./overview.md) — testing philosophy and test types
- [`.context/architecture/ci.md`](../architecture/ci.md) — `test-full` vs
  `test-changed` in CI, and the `CI_TEST_SCOPE` knob
- `scripts/ci/scoped-tests.ts` — the list, the detector, and the reasoning
- `scripts/ci/run-scoped-tests.ts` — the CLI
