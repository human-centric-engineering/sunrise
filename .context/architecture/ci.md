# Continuous Integration

How Sunrise's GitHub Actions pipeline works, how it adapts to public vs private
repos, and the two knobs a fork may want to flip. The pipeline is designed to be
**correct and fast on both** the public Sunrise repo (free Actions minutes,
4-core/16GB runners) and private forks (capped minutes, 2-core/8GB runners).

## Workflows

| File                                        | Trigger                      | Purpose                                                                                                                                                 |
| ------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                  | push to `main`, PR to `main` | Type-check, lint/format, build, tests, real-DB smoke (migration drift + erasure + subject-access export), Docker build + stack smoke, lockfile metadata |
| `.github/workflows/codeql.yml`              | push, PR, weekly cron        | SAST → Security → Code scanning (skips on private; see below)                                                                                           |
| `.github/workflows/dependency-review.yml`   | PR to `main`                 | Blocks PRs adding vulnerable deps (skips on private; see below)                                                                                         |
| `.github/workflows/secret-scan.yml`         | push, PR, weekly cron        | **Two** gates: TruffleHog (diff on PR, full history on cron) **and** a Postgres DSN tripwire (see below)                                                |
| `.github/workflows/dependency-audit.yml`    | weekly cron, manual          | Audits the tree **as it stands**: advisories + `libc` completeness                                                                                      |
| `.github/workflows/fork-sync-integrity.yml` | push to `main`, manual       | Detects a squash-merged sync PR that silently reset the merge base (no-op upstream; see below)                                                          |

## `ci.yml` shape

A `config` job detects what changed, then the work fans out so failures surface
in parallel rather than serially:

```
config ──┬─ typecheck
         ├─ lint & format
         ├─ build
         ├─ test-full   (4-way shard matrix)   ┐ exactly one test
         ├─ test-changed (single, PR only)     ┘ job runs (see below)
         ├─ smoke — real-DB invariants (drift + erasure + export)
         ├─ docker — build + prod-stack smoke  (parallel; gated on PRs)
         └─ lockfile — platform metadata       (PRs touching the manifest)
                                   └─ ci-status (branch-protection gate)
```

`ci-status` is the single required check: it runs `always()` and fails only if a
job that actually ran failed. Skipped jobs (docs-only changes, the inactive test
mode, non-Docker PRs) are **not** failures, so they don't wedge the gate.

### How `config` gets the changed-file list, and why it fails open

Because a skipped job passes, **a short file list is a silent green build.** Every
gate defaults to off and is switched on by a matching path, so any file missing
from the list is a check that never ran — type-check, lint, tests, docker, and
the `lockfile` supply-chain job.

The job previously read `gh pr view --json files`, which goes through GraphQL
and pages `files(first: 100)` without following on. Measured against
`kubernetes/kubernetes#141224` (411 files): it returns exactly **100**. PRs now
use the REST files endpoint with `--paginate`, which returns all 411 (its own cap
is 3000).

The push path uses the commits API the same way. It caps at 300 files **per
page** but does paginate — the un-paginated response carries `Link: rel="next"`,
and `--paginate` returns all 411 on the same commit. Both paths pass
`per_page=100` so a large diff costs 5 requests rather than 14; each extra
request is another chance for a 5xx to abort the step.

**Both endpoints then stop at a hard 3000 files, `--paginate` or not.** Measured
on `torvalds/linux` `1da177e4` (~17k files): exactly 3000. The final page comes
back as `files: []` with HTTP 200, so `gh` exits 0 and a truncated list looks
exactly like a complete one. Numbers here are worth re-measuring rather than
trusting: three separate claims in this section were wrong before they were
right.

| Endpoint               | Per page | Paginates?              | Hard cap |
| ---------------------- | -------- | ----------------------- | -------- |
| GraphQL (`gh pr view`) | 100      | no                      | 100      |
| REST `/pulls/N/files`  | 100      | yes                     | 3000     |
| REST `/commits/SHA`    | 300      | yes                     | 3000     |
| REST `/compare/A...B`  | 300      | over commits, not files | 300      |

> An earlier revision of this section said the commits API "does not paginate"
> and called it measured. It was not: the 300 came from a run **without** the
> flag. The `compare` endpoint genuinely does cap at 300 — its pagination is over
> commits, not files — and that measurement got reported as though it covered
> both. Left here rather than quietly deleted, because the wrong version was
> stated confidently in three places.

Two safety nets, because the list being complete is load-bearing:

- **PRs cross-check the count** against the PR's own `changed_files` field rather
  than trusting pagination, so a cap — the 3000 one, or a future reintroduced
  one — is caught instead of inherited. The push path has no equivalent, because
  a commit object reports no file total; there the 3000 cap itself is the only
  available signal, and reaching it counts as truncation. An exact alternative
  exists (check out and `git diff --name-only` the push range, which has no cap)
  and is noted in the workflow; it is not taken because it adds a checkout to a
  job that is otherwise API-only and seconds long.
- **The truncation flag defaults to `true`** and is cleared only by a positive
  numeric match. Starting it `false` meant a comparison that merely _errored_
  (an empty `$TOTAL` makes `[ "$COUNT" -ne "$TOTAL" ]` exit 2, and `set -e` is
  exempt inside an `if`) carried on with whatever partial list came back — fail
  _closed_, in the one place that must fail open.

On truncation the job sets `code`, `docker` and `deps` all true and emits a
`::warning::`. Running everything on a huge diff is the cheap mistake; skipping
the supply-chain check on the largest PRs is the expensive one — and a release
PR is exactly the large-diff case (#591).

**`ci-status` fails on anything that is not `success` or `skipped`.** It used to
test for the literal string `failure`, which let `cancelled` through — a job
killed by its own `timeout-minutes` (the docker job carries 30), or a run
cancelled while `ci-status`'s `if: always()` still fires, reported "CI passed"
for gates that never finished.

**`ci-status`'s job list is maintained by hand, in two places.** Both the
`needs:` array and the shell loop below it enumerate every gating job
explicitly — there is no dynamic "all jobs" expression in GitHub Actions to use
instead. **A job you add to `ci.yml` does not gate anything until you add it to
both.** It will run, it can fail, and `ci-status` — the single required check on
the branch-protection rule — will still report success. Forks extending the
pipeline are the likely victims here, since adding a fork-specific job is an
expected thing to do. Check both lists whenever you add a job.

**`ci-status` lists `config` in its `needs`.** Every other job is gated on
`config`'s outputs, so if `config` itself fails they all resolve to `skipped` —
and a loop that passed on `skipped` reported success for all of them. Without `config` in the
list, one API hiccup in change detection produced "CI passed" with zero gates
run: the same hole as a truncated file list, one job further up.

**Exception — `lint & format` runs on every PR, including docs-only.** Most jobs
are gated `if: needs.config.outputs.code == 'true'` and skip on docs-only changes
(`*.md`, `.context/**`). `lint & format` is deliberately **not** gated at the job
level, because `npm run format:check` is repo-wide (Prettier checks Markdown too).
If it skipped on docs-only PRs, an unformatted `.md` could land on `main`
unchecked and then fail the _next_ code PR's whole-repo `format:check`, misattributed
to an unrelated author (issue #314). ESLint has nothing to check in docs, so it
stays gated at the **step** level (`ESLint (code changes only)`) — docs-only PRs
run only the Prettier check and the CHANGELOG check below, and stay cheap
(~1m35s vs ~8m for a cold code PR).

### The `CHANGELOG structure` step

Ungated for the same reason as `format:check`: a CHANGELOG-only PR is
docs-only, so a code-gated check would skip the change most able to break the
file. It runs `scripts/ci/check-changelog.ts`, which is also the **first** link
in `npm run validate` — a check that only exists in CI is one people discover by
having a PR rejected, and this one takes milliseconds, so it fails ahead of the
thirty-second type-check rather than behind it.

The rules and the reasoning behind each live in
`scripts/ci/changelog-structure.ts`. Two are worth knowing here:

- **Static rules** need nothing but the file and `SUNRISE_VERSION`: headings
  unique, in descending SemVer order, dated, `## [Unreleased]` present and
  first, `### ` categories canonical and not repeated within a section, and the
  topmost release equal to `SUNRISE_VERSION`.
- **Released headings are append-only.** A heading present on the base revision
  must still be present here. This is the rule that catches the incident behind
  #550, and the only one that can — a deleted heading leaves a file that is
  valid in every static sense. Because it needs the previous revision, the step
  shallow-fetches the PR's base SHA (not the base branch tip, which may carry a
  release the PR has legitimately not merged) and passes it as `--base`. An
  unreadable `--base` is a hard failure, so a broken fetch surfaces rather than
  silently downgrading to the static rules.

Locally, `npm run check:changelog` takes no arguments: it falls back to the
merge base with `origin/main`, and **skips the history rule quietly** when that
is unavailable — a fresh clone with no remote, a detached HEAD, or a fork whose
upstream is named something else. CI is where that rule is enforced.

`npm run check:changelog-drift` is a **separate, local-only** check and is
deliberately not a CI job. It asks whether an `[Unreleased]` bullet is still
true after everything else the branch did — the failure `check:changelog`'s
structural rules cannot see, because a falsified claim leaves a perfectly
well-formed file. Its identifier correlation is a heuristic, so it never gates
and has no place in a pipeline that blocks merges; `/pre-pr` step 5e runs it and
the agent judges the output (#627).

> **Fork note.** The check assumes `CHANGELOG.md` carries Sunrise's release
> history. A fork that empties the file, or renumbers it to its own app
> versions, fails the `SUNRISE_VERSION` agreement rule on **every** PR
> thereafter, since the topmost heading no longer names the platform release
> the fork is on. The append-only rule is the milder half: it fails on the PR
> that does the emptying and then goes quiet, because from the next PR onward
> the emptied file is the base. Keep Sunrise's history in `CHANGELOG.md` and
> put your app's release notes in a file of your own; all four current forks
> already do the former by default, simply by merging upstream.

### The `Prisma schema format check` step

Unlike the CHANGELOG step above, this one **is** gated on the code filter
(`if: needs.config.outputs.code == 'true'`) — correct, because editing a
`.prisma` file sets `code=true`, and a docs-only PR cannot change schema
formatting. Since #510 it runs the same `npm run format:prisma:check` that
`npm run validate` does, rather than keeping its own copy of the logic. Prettier has no `.prisma` parser, so this drift is
invisible to `format:check`, and while the check lived only in CI the first
signal was a red job named "Lint & format" on a branch about something else.

**Forks feel this more than core does.** The `/framework` and `/app` tiers own
`prisma/schema/framework-*.prisma` and `app.prisma` — precisely the files core
never reformats, because core never edits them. A Prisma bump upstream
therefore invalidates the formatting of files only the fork owns, and until now
no fork could catch it before pushing.

The check walks `prisma/schema` recursively (so does `prisma format`), runs
Prisma's declared entry point under `node` rather than `npx` or the `.bin`
shim — neither of which can be spawned on Windows without a shell, and a shell
concatenates argv without escaping — and formats a **copy** in a temp directory
and compares, rather than running the formatter over `prisma/schema` and
diffing against git. The git
form is correct only on a clean tree: run it while editing a schema and it
reports your own well-formatted uncommitted work as drift. `npm run
format:prisma` is the mutating fixer; `format:prisma:check` never writes, which
is what makes it safe inside `validate`.

### The `Node version consistency` step

**`.nvmrc` is load-bearing.** Every `actions/setup-node` in both `ci.yml` and
`dependency-audit.yml` resolves its version with `node-version-file: '.nvmrc'`
rather than a literal. Delete or rename that file and every job that installs
Node fails — which is the intended trade: before #581 the major was hardcoded
in eight places and nothing kept them in step.

Consolidating the CI pins left **five** declarations that no tool can merge,
across four files: `.nvmrc` (what CI installs), `Dockerfile` and
`Dockerfile.dev` (what ships), `engines.node` in `package.json` (what forks are
told, and what **Vercel** resolves its runtime from — see
[`vercel.md`](../deployment/platforms/vercel.md)), and the `@types/node`
devDependency (what `tsc` believes). A `FROM` line cannot read `.nvmrc` and npm
cannot read a Dockerfile, so this step reconciles them instead.

`@types/node` was excluded when the check first landed and was the one that
disagreed — `^26` against a `>=24` runtime, so `tsc` accepted any API added in
Node 25 or 26 and reported nothing, with the first signal a `TypeError` in the
production image on a path the types called safe. It joined the check in #584;
pinning to `^24` produced a clean `tsc --noEmit`, so nothing depended on the
post-24 surface. Only the MAJOR is compared — `24.x` minors should move freely,
since that is the types package tracking Node 24's own additions.

The source reads the **resolved** version from `package-lock.json`, not the
range in `package.json`. A range need not pin a major — `>=24` resolves to
26.2.0, and `>24` parses as the one major it excludes — so a range-based reading
reported "consistent" for precisely the drift this source was added to catch.
The question is "what is `tsc` loading?", and only the lockfile answers it: a
loose `"*"` is therefore judged on what npm actually produced. It is checked
even when `@types/node` is not named in `package.json` at all, since `tsc` loads
a transitive copy just the same — and **skipped entirely when there is no npm
lockfile**, so a fork on pnpm or yarn is not failed by a check it cannot
satisfy. A Dependabot `ignore` holds it at `>=25`. Without it the major would re-land on
a Monday and turn this gate red, which is a worse way to learn the same thing;
with it, moving the runtime means moving all five declarations **and** that
entry together.

The drift it exists for is silent and asymmetric: bump `.nvmrc` alone and every
job here goes green on the new major while the image serving traffic still
builds the old one — the suite passes _because_ it stopped testing what ships.
Gated on the code filter, like the Prisma step; `.nvmrc`, both Dockerfiles and
`package.json` all set `code=true`.

An unparseable source fails rather than being skipped. When nobody is watching
these files, "cannot read it" and "it disagrees" have the same consequence.

**Forks:** if you retarget the base image (a different distro, or a pinned
digest), keep the `FROM node:<major>` shape or this check cannot read it. If
you drop `Dockerfile.dev` entirely, remove it from
`scripts/ci/check-node-version.ts` rather than leaving the check unable to
find it.

### Universal speedups (on for everyone)

These help both repo types and cost nothing, so they're always on:

- **Concurrency cancel** — superseded PR runs are cancelled (`cancel-in-progress`
  on PRs only; `main` runs are never cancelled — they're the post-merge record).
- **Warm build caches** — `actions/cache` persists `.next/cache` (Next build +
  ESLint cache), the Prettier cache, and `tsconfig.tsbuildinfo` (incremental
  `tsc`). Each fan-out job caches **its own** artifact under its own key — a
  shared key would let the first job to finish overwrite the others' caches.
- **Content-based cache strategy** — `eslint`/`prettier` run with
  `--cache-strategy content` (see `package.json`). The default `metadata`
  strategy keys on mtime, which a fresh CI checkout resets — so the restored
  cache never hit and lint re-ran fully every time (~220s). Content hashing fixes
  that (lint ~220s→~2s, format ~62s→~8s warm).
- **Raised Node heap** — `NODE_OPTIONS=--max-old-space-size=5120`
  (workflow-level) and a `NODE_HEAP_MB` build arg defaulting to 4096 in the
  Dockerfile `builder` stage. It's a **cap, not an allocation**: never
  approached on a 16GB runner, but it stops `tsc`/`next build` OOMing (exit 134)
  on an 8GB runner where Node's default heap caps near ~2GB. The Dockerfile cap
  lives in the `builder` stage only — the `runner` stage is a fresh `FROM base`
  and doesn't inherit it, so production runtime memory is unchanged.
- **Sharded tests** — the full suite runs as a 4-way `vitest --shard` matrix
  (~3.3× faster wall-clock). N=4 was the sweet spot in benchmarking; N=8 hit
  per-shard overhead (each shard re-pays checkout + `npm ci` + DB setup).
- **Decoupled, gated Docker** — the `docker` job no longer waits on the checks
  (an image break surfaces in parallel). On PRs it runs only when Docker-relevant
  files change; on push to `main` it runs as the production-image gate for any
  change that touches code (a docs-only push still skips it).
  The path filter covers `Dockerfile`, `Dockerfile.dev`, `.dockerignore`,
  `docker-compose*.yml`, `.npmrc`, `package.json`, `package-lock.json`,
  `next.config.*`, `prisma.config.ts` and **`prisma/*`** (a single star — bash
  `case` lets `*` cross `/`, so it matches the whole subtree). The last one means every schema or
  migration PR runs the heaviest job — deliberate, because the job now applies
  those migrations for real.

- **The docker job runs the stack, it does not just build it.** It builds the
  `runner`, `migrator` and `seeder` targets with `load: true`, asserts image
  invariants (musl-only `sharp` per #571; no Prisma CLI in the runtime image per
  #583; **`prisma/seeds/data/chunks/chunks.json` present in the runtime image**),
  brings up `db` + `migrator` + `web` from `docker-compose.prod.yml`, and
  asserts the migrator exited 0, `web` reached healthy, `/api/health` reports a
  connected database, a Prisma **model** query succeeds, and the seeder
  completes. `nginx` is never started (it binds :80/:443).

  The `chunks.json` assertion is the least obvious of the three and the most
  fragile. The admin knowledge-seed route reads it at
  `path.join(process.cwd(), 'prisma/seeds/data/chunks/chunks.json')`, and after
  the wholesale `COPY /app/prisma` was dropped, the file survives into the image
  **only** because Next's file tracer statically evaluated that `join`. Nothing
  else holds it there — there is no `outputFileTracingIncludes` entry as a
  backstop, and the stack smoke never exercises that admin-authed route. An nft
  upgrade, or a refactor that moves the path into a variable, would ship an image
  that 500s with `ENOENT` while every job stayed green. If you add another
  runtime file read this way, assert it here too, or give it an explicit
  `outputFileTracingIncludes` entry.

  Two further details of those assertions are deliberate and easy to "tidy" into
  uselessness. The health check asserts `connected == true` and accepts
  `operational` **or** `degraded`, because `determineServiceStatus` downgrades
  above 500 ms latency while still returning 200 — asserting `operational`
  would red-X a merely contended runner. And the model query runs **in the
  container, not over HTTP**: the obvious HTTP probe went through a route whose
  handler catches every error and returns the same 404 a successful lookup
  returns, so it passed against an image with the Prisma wasm compiler deleted.

  This exists because the previous version used `push: false` with no `load`,
  so nothing ever ran the image. #583 — the production stack could not start at
  all — survived four months of green Docker builds. A build-only check cannot
  catch a runtime-only fault.

  Cost on a private fork (2-core/8GB): roughly +3–5 minutes, no extra `npm ci`
  and no extra `next build`, inside a `timeout-minutes: 30` cap. There is no
  opt-out variable — unlike `CI_TEST_SCOPE` and `CI_NODE_HEAP_MB`, whose failure
  modes are opaque, this job's cost is visible and already path-gated. A fork
  that must drop it edits the one `if:` line, and accepts that the compose stack
  is then unverified. Watch disk rather than minutes: three loaded images.

- **Lockfile metadata on manifest PRs** — the `lockfile` job runs
  `check:lockfile` whenever `package.json` or `package-lock.json` moves (a
  `deps` output from `config`, alongside `code` and `docker`). It is the
  **offline diff** check — it compares the two revisions' own contents and
  makes no registry calls — which is what makes it safe as a PR gate; the
  absolute counterpart (`fix:lockfile-libc --check`, ~1,400 registry requests)
  stays on the weekly schedule in `dependency-audit.yml`.

  **A direct downgrade reports, it does not gate.** The rule was a proxy for "a
  patched dependency returned to a vulnerable one", which `dependency-review`
  measures exactly on every PR (`fail-on-severity: high`) and `check:audit`
  covers weekly for the standing tree. Measured across all 151 commits that
  touched this lockfile it would have fired twice — both deliberate pins, zero
  accidents — and the cost of that was real: a correct one-line `@types/node`
  pin needed a 250-line acknowledgement mechanism to become mergeable.
  `dependency-review` is **skipped on private repos**, so a private fork loses
  the per-PR enforcement; the downgrade is still printed in its own block with
  that caveat.

  **Lost `libc`/`os`/`cpu` still gates unconditionally. An `overrides` change
  gates only when it is unexplained** — the key's `overrideReasons` entry in
  `package.json` has to move in the same diff (#608). Before that the rule
  failed on every override change and ended with the word "Intentional?", which
  is a question a build cannot be told the answer to: wired into branch
  protection, the only routes past were bypassing the protection or weakening
  the rule. Measured against every commit that had touched `package.json` up to
  that point — 149 of them, at `07a14800` — the overrides block moved **once**,
  six months before this check existed, so it had never fired in its own
  lifetime when the fix landed. Reasons for keys a diff did not touch are never
  read, so a fork inheriting the upstream block is unaffected.

  It exists because `/pre-pr` runs this check locally and **Dependabot PRs never
  run `/pre-pr`**. npm below 11.11.0 deletes `libc` from every entry it writes,
  on every platform, and the result installs fine locally and wrong on Alpine —
  #571 shipped that way for two releases. Restricted to `pull_request`: on a
  push to `main` the merge base is HEAD, so the job would diff the tree against
  itself and pass on anything.

### Knob 1: `CI_TEST_SCOPE`

The choice that most differs by repo economics is **how much test work runs on a
PR**. Controlled by the repository variable `CI_TEST_SCOPE`
(Settings → Secrets and variables → Actions → Variables):

| Value                    | PR branches                                      | push to `main`                | For                                     |
| ------------------------ | ------------------------------------------------ | ----------------------------- | --------------------------------------- |
| unset / `full` (default) | full suite, 4-way sharded                        | full suite, 4-way sharded     | Public Sunrise; any fork in production  |
| `changed`                | only tests the diff affects (`vitest --changed`) | **full suite, 4-way sharded** | Private free-tier forks, pre-production |

Any value other than exactly `changed` falls back to `full` — a typo fails safe
to the strong gate.

**Why default to `full`:** a green PR check should mean the whole suite passes on
that commit. The default never weakens that, and sharding keeps it fast.

**When to set `changed`:** a private fork on the free tier has capped minutes and
2-core runners, where a full 4-way sharded run on every fixup push is wasteful
during rapid early development. `changed` runs only the affected tests on PR
branches (fast, cheap) — **and still runs the full sharded suite on push to
`main`**, so nothing reaches `main` unverified. You trade a lighter PR-branch
gate for speed. Flip back to `full` before you take the app to production.

```bash
# Private free-tier fork, early development:
gh variable set CI_TEST_SCOPE --body changed
# Going to production — restore the strong PR gate:
gh variable set CI_TEST_SCOPE --body full   # (or just delete the variable)
```

### Knob 2: `CI_NODE_HEAP_MB`

The workflow raises Node's heap **cap** globally (a ceiling, not a reservation —
harmless on a 16GB public runner, necessary on an 8GB private-fork runner where
Node's default caps near ~2GB):

```yaml
NODE_OPTIONS: '--max-old-space-size=${{ vars.CI_NODE_HEAP_MB || 5120 }}'
```

**The symptom is the hard part.** 5120 is sized for base Sunrise. A fork with a
meaningful amount of added code can push type-aware ESLint (or `tsc` /
`next build`) past it, and the job dies with **exit 134** — SIGABRT, i.e. the
allocator aborting. There is no "out of memory" message and no stack pointing at
memory; it reads like a crashed toolchain. If a job fails with exit 134 and no
diagnostic, raise this variable before investigating anything else.

```bash
# Fork whose lint job OOMs at the default. Bisect upward from 5120 rather than
# jumping — the value you land on has to fit the SMALLEST runner the repo will
# ever build on, and that is 8GB the day it goes private.
gh variable set CI_NODE_HEAP_MB --body 6144
```

**6144, not 8192, and the difference matters.** An earlier revision of this
section used 8192 as its example, four lines above a rule forbidding it — see
below. A fork that took the example at face value carried a cap above its own
runner's memory, which is the one configuration this knob must never produce.
Find the real floor by bisection: raise until lint and `next build` both pass,
then stop. Measured on one ~2x-Sunrise fork, lint aborts at 5120 and passes at
6144 with a 5.6 GiB peak — so the gap between "fails" and "works" is one step,
and 8192 was never needed.

**The same wall exists locally, and this variable does not reach it.** `npm run
lint` therefore runs through `scripts/run-capped.mjs`, which appends a
`--max-old-space-size` to `NODE_OPTIONS` — but **only when nothing has set one
already**, so in CI this variable still wins. A developer hitting exit 134 on a
laptop is the usual first sighting of a fork outgrowing the default; see
[`lint-toolchain.md`](./lint-toolchain.md#memory-why-lint-runs-under-an-explicit-heap-cap)
for the measured per-fork numbers and the local `NODE_HEAP_MB` override.

Setting it as a repo variable rather than editing `ci.yml` matters: an edit to
the workflow file is reverted by every upstream sync, so the fork rediscovers the
same opaque failure each time. Keep the value at or below the runner's physical
memory — a cap above available RAM just moves the failure from a clean abort to
the OOM killer. On a private fork that ceiling is **8GB minus the OS, git and
npm**, so treat ~6GB as the practical maximum, not 8. (None of the jobs this
knob applies to attaches a service container; since #629 the test jobs don't
either.)

**It is a _per-process_ cap, and the test jobs are the only multi-process ones.**
`--max-old-space-size` applies to each Node process, not to the runner. Every job
this knob is aimed at — type-aware ESLint, `tsc`, `next build` — is a single
process, so "cap ≤ physical memory" is the whole rule for them. `test-full` and
`test-changed` are different: vitest forks roughly `cores - 1` workers, each its
own Node process inheriting the same ceiling. The rule there is

```
workers × CI_NODE_HEAP_MB  ≤  runner memory − OS
```

At the 5120 default that is already ~15.4GB of ceiling on a 4-vCPU/16GB public
runner. At `CI_NODE_HEAP_MB=8192` — the value this section tells you to set when
lint dies with exit 134 — it is ~24.6GB on the same 16GB runner, and on a
2-vCPU/8GB private runner vitest forks about one worker, so a single 8192 cap
already sits at the machine's ceiling before the OS is counted.
**So the documented fix for one job was the trigger for the other**, and the
resulting failure is the worse kind: an OS OOM kill of a worker rather than a
clean V8 abort, surfacing as `Failed to start forks worker` or a shard that
vanishes from the summary count.

Both test jobs therefore opt out of the workflow-level ceiling at job level.
Node's own default heap is derived from the machine's memory, so it adapts to
public and private runners without a knob, and it is what the suite already runs
under locally. **If you add a job that runs vitest (or anything else
process-parallel), give it the same override** — a job that merely inherits the
workflow `env:` is silently opting into `N × CI_NODE_HEAP_MB`.

**A workflow-level `env:` does not cross into a container build.** This is the
non-obvious part, and it produced a distinctive symptom: raising the variable
fixed `typecheck`, `lint` and `build` while `docker` kept OOMing at exactly
4128 MB, so the knob appeared to do nothing and the one job still failing was
the one it had never been wired to. The `docker` job therefore forwards the same
value explicitly as a `NODE_HEAP_MB` build arg, and `docker-compose.prod.yml`
exposes it too (`NODE_HEAP_MB=${NODE_HEAP_MB:-4096}`) so a self-hosted build
hits the same wall with the same lever (#543).

The Dockerfile default stays **4096**, not the workflow's 5120: that stage is
sized for ~8GB hosts, where a bigger cap trades a clean V8 heap error for an
OS-level kill. Only a caller that knows its runner is larger asks for more.

### Knob 3: `CI_TEST_NODE_HEAP_MB`

Unset by default, which means no `--max-old-space-size` flag on the test jobs at
all. It exists so a fork whose workers genuinely need more than Node's default
still has a repo-variable path — the same "don't edit the workflow, it won't
survive a sync" rule as the other two knobs — without reaching for
`CI_NODE_HEAP_MB`, whose entire problem is that it is sized for one process.

```bash
gh variable set CI_TEST_NODE_HEAP_MB --body 3072
```

**Size it per worker, not per runner:** `workers × value ≤ runner memory`. On a
2-vCPU runner vitest forks roughly one worker, on 4-vCPU roughly three — so the
same value means very different totals, and the whole-runner figure that is
right for `CI_NODE_HEAP_MB` is wrong here.

## Private-fork correctness (GHAS-dependent jobs)

CodeQL and Dependency Review both upload to GitHub Advanced Security, which is
**free on public repos but paid on private**. On a private fork without GHAS they
fail (`Advanced Security must be enabled…`). Both skip automatically on private
— no configuration needed:

- **`dependency-review.yml`** reads `github.event.repository.private` directly.
  Safe because this workflow only triggers on `pull_request`, where that field is
  always populated.
- **`codeql.yml`** can't use that field — it's **absent on `schedule` events**
  (the weekly cron), so a naive `!github.event.repository.private` check would
  run-and-fail on private and disable the scan on public. Instead a tiny `guard`
  job resolves visibility via `gh api repos/{repo} --jq .private`, which works on
  every event. Result: the public scheduled scan keeps running, and private forks
  skip cleanly across **all** events.

Dependabot (existing deps), TruffleHog (secret scanning) and `dependency-audit`
(`npm audit` + the `libc` completeness check) are unaffected — they work on
private repos regardless, needing no Advanced Security.

### `Fork Sync Integrity` — the one job that only ever fires downstream

`scripts/ci/check-sunrise-ancestry.sh` asserts that the release the tree
**claims** in `lib/sunrise-version.ts` is genuinely an **ancestor** of `HEAD`.

It exists because a fork that squash-merges its sync PR keeps every file but
loses the second parent, so the merge base against upstream silently reverts to
the previous release and the next sync re-conflicts everything already resolved
by hand. Neither repo settings nor documentation can prevent it — rulesets can
only restrict merge methods for _every_ PR into the branch, and merging is a
human click months after anyone read the sync guide. So this is **detection**:
it collapses time-to-discovery from months to minutes, because the repair is
trivial only while the context is fresh.

**It is a guaranteed no-op in Sunrise's own repo.** Sunrise tags every release
on `main`, so the tag is always an ancestor. It is also self-enforcing: a fork
receives the workflow _by doing a sync merge_, so squashing that sync makes it
fire on the first run afterwards.

**Five** deliberate non-failures, each of which would otherwise red-line a build
for something that is not a lost merge base. The script has exactly one `fail`
path; everything else skips:

| Situation                                      | Behaviour            | Why                                                                                                                                          |
| ---------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| No `SUNRISE_VERSION` in the tree               | skip + `::warning::` | Nothing is being claimed, so there is nothing to check                                                                                       |
| Shallow clone                                  | skip + `::warning::` | `merge-base` would answer from truncated history and report a loss that has not happened                                                     |
| Tag not fetchable                              | skip + `::warning::` | Mid-release (every Sunrise release, at the moment of cutting it) or an unreachable upstream                                                  |
| Fetched tag claims a different Sunrise version | skip + `::warning::` | It is some other project's release of the same name — see the identity check below                                                           |
| `merge-base` exits non-zero **and non-1**      | skip + `::warning::` | Only exit 1 means "not an ancestor"; 128 is a git error, and reporting it as a finding would announce a lost merge base for a corrupt object |

**Every skip emits a `::warning::` annotation.** All three exit 0, and a bare
`echo` would render the check fully green with nothing on the run — which, for a
guard whose entire premise is time-to-discovery, would reinstate the original
failure mode one level up. The skips are the residual risk in this design, so
they are made visible rather than merely logged.

Four implementation details are load-bearing. Each was confirmed by control
experiment, and `tests/unit/scripts/ci/check-sunrise-ancestry.test.ts` fails
against the naive version of each:

- **Upstream's tag is fetched into a private ref, not `refs/tags/`, and there is
  no fallback to the local tag.** A fork versions its app independently of
  Sunrise, so it may hold its own `v0.8.0` pointing at its own history — which
  _is_ an ancestor of its own `main`, so a `refs/tags/`-based check reports
  **success on the very repository it exists to protect**. The mirror case is
  worse: where the fork's own tag is _not_ an ancestor, such a check fails and
  tells the operator to `git merge -s ours` an unrelated release branch into
  `main`, recording a claim that is false. An earlier revision fell back to the
  local tag when the fetch failed and reinstated both; an unreachable upstream
  now skips instead, because the honest answer is that we could not look.
- **`fetch-depth: 0` is required** in the workflow. Lowering it does not disable
  the guard quietly — the shallow check turns it into a skip with a
  `::warning::` annotation on the run.
- **The fetched tag is checked for identity, not just fetched.** The tag name is
  Sunrise's namespace but resolves against whatever `UPSTREAM_URL` points at, so
  a framework-tier fork's own same-named release would otherwise be treated as
  Sunrise's — the private-ref collision again, arriving through the escape
  hatch. The tag's own `lib/sunrise-version.ts` must equal the claim; every
  Sunrise release tag satisfies that by construction (verified v0.5.0–v0.8.1).

  **This narrows the collision; it does not eliminate it.** The comparison is on
  the version _string_, so it still passes if an intermediate fork's own release
  number happens to equal the Sunrise version it carries — Daybreak cutting its
  `v0.8.1` while sitting on Sunrise 0.8.1. A tag name is not a globally unique
  identifier, and no amount of layering makes it one; this is why the guidance
  is to leave `UPSTREAM_URL` unset unless Sunrise's tags genuinely are
  unreachable, rather than to rely on the check.

- **The printed repair merges an explicit ref, never the bare tag name.** Plain
  `git fetch upstream --tags` is **rejected** when the fork already holds a tag
  of that name (`would clobber existing tag`, exit 1), leaving it pointing at
  the fork's own commit — so a repair naming the bare tag would record a false
  claim. The same collision, in the instructions rather than the detection.
- **The fetch's exit status gates the check, not the ref's existence.** A
  leftover `refs/sunrise-ancestry/*` from a killed run would otherwise be an
  undocumented fallback of exactly the kind removed above.

Two caveats for forks, both of which make the guard inert rather than wrong:
the workflow triggers on `push` to **`main`** only, so a fork with a different
default branch must edit the `branches:` filter; and a permanently-failing fetch
(a mistyped or expired `SUNRISE_UPSTREAM_URL`) skips forever. The skip
annotation quotes git's own error so the second is diagnosable from the run.

The failure message is emitted twice on purpose: plainly for the log, and
`%0A`-encoded onto a single `::error::` line. Workflow commands are line-scoped,
so without the encoding the annotation — the surface an operator sees without
expanding the job — would carry the diagnosis and leave the `git merge -s ours`
repair behind in log output.

`UPSTREAM_URL` is overridable via `SUNRISE_UPSTREAM_URL`, for a leaf fork of a
framework-tier fork. The workflow reads the **secret** first and falls back to
the **variable**: a private upstream needs a token in the URL, and secrets are
masked in logs and write-only, whereas `vars.*` are unmasked and readable back
through the API by anyone with write access.

### One caveat on the scheduled audit

`dependency-audit.yml` has **`schedule` as its only automatic trigger**, and
GitHub disables scheduled workflows in a repository after **60 days without
repository activity**. A dormant fork therefore stops auditing itself silently
— the one case the workflow was written for. `codeql.yml` and `secret-scan.yml`
degrade better here because they also trigger on push and PR.

This is a known trade-off rather than an oversight: adding a `push` trigger
would turn an advisory report into a `main`-branch gate, and the job is
deliberately non-gating for findings nobody can act on. If a fork wants the
stronger guarantee, add `workflow_dispatch` to a release checklist or give the
workflow a `push: paths: ['package-lock.json']` trigger — the answer only
changes when the lockfile does.

Note this concerns _dormancy_, not forking as such: Sunrise's downstream repos
are **separate repositories** sharing history via an `upstream` remote, not
GitHub forks, so the "Actions is disabled by default in a fork" rule does not
apply to them. It would apply to a true GitHub fork, which must enable Actions
before any of this runs.

### Conventions that hold across every workflow

Small things, uniform on purpose — a fork adding a workflow should match them.

**`permissions: contents: read` at file level, widened only per job.** All six
workflows declare it, and exactly two jobs need more — both widening at _job_
level rather than relaxing the file-level default:

| Job                              | Adds                                               |
| -------------------------------- | -------------------------------------------------- |
| `codeql.yml` → `analyze`         | `security-events: write`, `actions: read`          |
| `dependency-review.yml` → review | `pull-requests: write` (posts the failure comment) |

Copy that shape: the file-level block is the floor every job gets, and anything
only one job needs belongs on that job.

`ci.yml` is itself a partial exception worth knowing about — it declares
`pull-requests: read` at file level because the `config` job calls
`gh api .../pulls/{n}/files` to build the changed-file list, so every other job
in that workflow carries a read scope it never uses. Narrowing it to `config`
would be strictly tighter; it is called out here rather than presented as the
pattern to copy. Without an explicit block the token defaults to
whatever the repository setting says, which on an older fork can still be
read/write across the board.

**`timeout-minutes` on jobs that start containers.** GitHub's default is six
hours, which a hung health-wait will happily burn. Two jobs carry a cap:
`ci.yml`'s `docker` job (30) and `fork-sync-integrity` (5). The other jobs run
processes that terminate on their own, so they are deliberately uncapped — the
rule is "cap anything that waits on something else's readiness", not "cap
everything". Note the interaction with `ci-status`: a job killed by its own
timeout reports `cancelled`, which the gate treats as a failure precisely so a
timeout cannot pass as a skip.

**Buildx GHA cache, written by exactly one build.** The runtime image build uses
`cache-from: type=gha` **and** `cache-to: type=gha,mode=max`; the `migrator` and
`seeder` builds use `cache-from` only. That asymmetry is load-bearing — buildx
keeps one builder for the whole job, so the later targets hit its local cache and
cost seconds anyway, while a second `cache-to` on the same scope would overwrite
the runtime image's entry, which is the one worth keeping warm. If you add a
build target, give it `cache-from` and leave `cache-to` alone.

**`check:audit` has a severity floor.** `dependency-audit.yml` calls
`npm run check:audit` with no arguments, which means the default floor of
**`high`**. The script accepts `--floor=<severity>` (`low`/`moderate`/`high`/
`critical`), so a fork with a stricter posture can tighten it in one place. It
also distinguishes fixable from unfixable: only advisories with a reachable
patched version gate the job — ones needing a major bump, or with no published
fix, are reported and pass, because failing on them makes the job permanently red
with no action available.

### The Postgres service container

One job attaches one — `smoke`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg15
    env: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres, POSTGRES_DB: sunrise_ci }
    ports: ['5432:5432']
    options: >-
      --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
```

**`pgvector/pgvector:pg15`, not stock `postgres`** — the schema declares a
`vector` column and HNSW indexes for knowledge-base search, so `db:migrate:deploy`
fails against an image without the extension. That is the constraint a fork will
trip if it swaps the image for a plain `postgres:15`.

The `pg_isready` health check is what makes the container's readiness a
precondition of the first step rather than a race: GitHub holds the job until it
passes, up to 5 × 10s.

`smoke` is the only consumer: migration drift, the erasure invariants, and the
~28 subject-access export queries all need Postgres, because the vitest suite
mocks Prisma and so never executes them.

**`test-full` and `test-changed` used to attach one too, and it was dead weight
(removed in #629).** `tests/setup.ts` is a global `setupFiles` entry and
overwrites `DATABASE_URL` with `postgresql://test:test@localhost:5432/test` — a
user and database the container never creates — so anything inside vitest that
tried to connect would fail authentication rather than reach `sunrise_ci`.
Nothing tries: no test constructs a `PrismaClient`, and `lib/db/client.ts` does
not connect at import (a pg `Pool` and a `PrismaClient` both connect lazily, on
first query). Of the 332 test files importing `@/lib/db/client`, 330 `vi.mock`
it; the two that do not are safe for their own reasons — `lib/db/client.test.ts`
mocks one layer lower at `@prisma/client` via `vi.doMock`, and
`structured-completion-no-persistence.test.ts` only reads the module path as a
_string_ out of source text. The container's only consumers were the
`db:migrate:deploy` and `db:seed` steps that ran ahead of vitest and fed nothing.

Both jobs keep `DATABASE_URL`, for the same reason `typecheck`, `lint` and
`build` do: `prisma generate` runs on `postinstall` and wants the variable
defined, without connecting.

What it cost, measured on a 4-shard public run (#626): `Initialize containers`
22s + `db:migrate:deploy` 2s + `db:seed` 13s = **~37s per shard against a 143s
vitest step**, paid four times over on four separate containers — ~2.5
job-minutes on every push, and a term in the heap budget above on the runner
where it is tightest.

**Fork impact.** An unmodified fork loses nothing. A fork that has edited
`tests/setup.ts` to point at the CI database _and_ added genuinely DB-backed
tests will go red — re-adding the `services:` block above plus the two steps is
the fix.

### `Secret Scan` runs two gates, not one

The workflow is named for TruffleHog, but it has a second merge-blocking step
that fails independently: **`Postgres DSN tripwire`**, running
`scripts/ci/check-postgres-dsn.sh`. A PR can pass TruffleHog and still be
blocked by it, and the failure names neither TruffleHog nor the workflow's own
title — so it is worth knowing it exists before you meet it.

**Why there are two.** TruffleHog's Postgres detector produced 27 unverified
findings on this repo and zero verified ones — every hit a `localhost` or `db`
fixture in a test, a doc, `.env.example`, or the CI workflow itself (#453). The
noise failed the gate. The available fix was a path allowlist, and
`.trufflehog-exclude.txt` duly exempts `tests/`, `.context/` and `.claude/`
wholesale — but an exclusion is per-path, not per-detector, so it silences
**every** detector in exactly the directories where someone is most likely to
paste a real key. The tripwire is what buys that exclusion back for the one
credential class provably living in those paths.

**What trips it.** It ignores paths entirely and scans every tracked file, so a
fixture cannot hide in an allowlisted directory. It fires only when a DSN pairs
a non-placeholder credential with a non-local host — both halves are checked, so
`postgres://user:pass@` at any host is fine, and so is any credential at
`localhost`. Local hosts include the Compose service names this repo uses (`db`,
`postgres`, `pgvector`), the usual placeholder words, and the RFC 2606
`example.com/.net/.org` domains.

**The fix path**, which currently exists only in the script's own failure
output:

- If it is documentation, use placeholder credentials (`user:pass`) or a local
  host. This is almost always the right answer.
- If the host is legitimately non-local and genuinely not a secret — a Neon
  pooler endpoint in a deployment guide, say — add it to `LOCAL_HOSTS` in
  `scripts/ci/check-postgres-dsn.sh`, **with a comment saying why**.

**Forks inherit both gates.** Neither needs Advanced Security, so unlike
`codeql.yml` and `dependency-review.yml` they keep working on a private fork. A
fork that adds its own deployment docs is the most likely thing to trip the
tripwire, and `LOCAL_HOSTS` is the seam for it.

One wrinkle, because the script's own comment got this wrong until recently and
the reasoning is worth keeping. That comment used to say the file "is not on
`.trufflehog-exclude.txt`". It is — the last entry in that file names it. Both were written in the same commit (`3712a013`): a literal
example DSN in the comment had failed the scan, so the fix removed the example
_and_ explained the removal by saying real source is never allowlisted — then
allowlisted it anyway, because the PR scan reads the whole commit range and the
history still carried the string. The justification was obsolete before it was
pushed.

What is actually true: TruffleHog does not scan this one file, and the tripwire
step does, over every tracked file regardless of path — so a real DSN pasted here
is still caught, and what is given up is TruffleHog's _other_ detectors over that
one CI script. Adding a placeholder example back would no longer fail
anything. Leaving it out is still the better call — a realistic-looking DSN in
the one file whose subject is committed DSNs invites exactly the confusion this
paragraph is untangling — but treat that as house style, not as a gate.

## Two gotchas worth knowing

- **`vitest --changed` runs the full suite when the diff touches
  `package.json`/config.** This is correct — a root-manifest change can affect
  anything — but it means dependency-bumping PRs don't get the fast path even in
  `changed` mode.
- **GitHub scopes Actions caches by branch** (a branch reads its own cache, then
  its base, then the default branch). Sibling feature branches don't share
  caches, so the warm-cache speedup only fully lands once a change is on the
  **default branch**. A fresh fork should expect the speedup after its first
  `main` build seeds the cache.
