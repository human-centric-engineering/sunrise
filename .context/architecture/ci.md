# Continuous Integration

How Sunrise's GitHub Actions pipeline works, how it adapts to public vs private
repos, and the one knob a fork may want to flip. The pipeline is designed to be
**correct and fast on both** the public Sunrise repo (free Actions minutes,
4-core/16GB runners) and private forks (capped minutes, 2-core/7GB runners).

## Workflows

| File                                      | Trigger                      | Purpose                                                            |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `.github/workflows/ci.yml`                | push to `main`, PR to `main` | Type-check, lint/format, build, tests, erasure smoke, Docker build |
| `.github/workflows/codeql.yml`            | push, PR, weekly cron        | SAST → Security → Code scanning (skips on private; see below)      |
| `.github/workflows/dependency-review.yml` | PR to `main`                 | Blocks PRs adding vulnerable deps (skips on private; see below)    |

## `ci.yml` shape

A `config` job detects what changed, then the work fans out so failures surface
in parallel rather than serially:

```
config ──┬─ typecheck
         ├─ lint & format
         ├─ build
         ├─ test-full   (4-way shard matrix)   ┐ exactly one test
         ├─ test-changed (single, PR only)     ┘ job runs (see below)
         ├─ smoke — account erasure (real DB)
         └─ docker  (parallel; gated on PRs)
                                   └─ ci-status (branch-protection gate)
```

`ci-status` is the single required check: it runs `always()` and fails only if a
job that actually ran failed. Skipped jobs (docs-only changes, the inactive test
mode, non-Docker PRs) are **not** failures, so they don't wedge the gate.

**Exception — `lint & format` runs on every PR, including docs-only.** Most jobs
are gated `if: needs.config.outputs.code == 'true'` and skip on docs-only changes
(`*.md`, `.context/**`). `lint & format` is deliberately **not** gated at the job
level, because `npm run format:check` is repo-wide (Prettier checks Markdown too).
If it skipped on docs-only PRs, an unformatted `.md` could land on `main`
unchecked and then fail the _next_ code PR's whole-repo `format:check`, misattributed
to an unrelated author (issue #314). ESLint has nothing to check in docs, so it
stays gated at the **step** level (`ESLint (code changes only)`) — docs-only PRs
run only the Prettier check and stay cheap (~1m35s vs ~8m for a cold code PR).

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
- **Raised Node heap** — `NODE_OPTIONS=--max-old-space-size=5120` (workflow-level)
  and `--max-old-space-size=4096` in the Dockerfile `builder` stage. It's a
  **cap, not an allocation**: never approached on a 16GB runner, but it stops
  `tsc`/`next build` OOMing (exit 134) on a 7GB runner where Node's default heap
  caps near ~2GB. The Dockerfile cap lives in the `builder` stage only — the
  `runner` stage is a fresh `FROM base` and doesn't inherit it, so production
  runtime memory is unchanged.
- **Sharded tests** — the full suite runs as a 4-way `vitest --shard` matrix
  (~3.3× faster wall-clock). N=4 was the sweet spot in benchmarking; N=8 hit
  per-shard overhead (each shard re-pays checkout + `npm ci` + DB setup).
- **Decoupled, gated Docker** — the `docker` job no longer waits on the checks
  (an image break surfaces in parallel). On PRs it runs only when Docker-relevant
  files change (`Dockerfile`, `package.json`, `next.config.*`, …); on push to
  `main` it always runs as the production-image gate.

### The one knob: `CI_TEST_SCOPE`

The only choice that genuinely differs by repo economics is **how much test work
runs on a PR**. Controlled by the repository variable `CI_TEST_SCOPE`
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

Dependabot (existing deps) and TruffleHog (secret scanning) are unaffected — they
work on private repos regardless.

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
