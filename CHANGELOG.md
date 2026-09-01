# Changelog

All notable changes to Sunrise will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) — see
[`VERSIONING.md`](./VERSIONING.md) for the public-surface contract and the
release process.

> **Status: `0.x` alpha.** The strict SemVer contract activates at `1.0.0`.
> During `0.x`, forks should expect real merge work between any two releases.
> See [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design)
> for what the version commits to (and does not) at this stage.

---

## [Unreleased]

### Added

- `registerRateLimitKeyResolver(key, resolver)` in `lib/security/rate-limit-policy.ts`
  opens the rate-limit **key** space to forks the way `registerRateLimitTier` opens
  the tier space: a fork can bucket requests by anything it can derive from the
  request (an org, a workspace, a device id) instead of only the four built-in
  strategies. `RateLimitRule.key` widens to `RateLimitKey | (string & {})` to
  match; a rule naming a custom key with no registered resolver throws at
  registration, and built-in strategies cannot be overridden. This closes the
  "a registry seam is only as open as its narrowest type" gap the multi-tenancy
  research called out — per-org quotas become expressible without editing
  `lib/security/`.
- `rlsEnabled(table, { requireForced? })` and `policyExists(table, policy)` probe
  factories in `lib/db/drift-probes.ts` (the drift-probe registry's primitives).
  A fork running the multi-tenancy retrofit can now assert its Row-Level-Security
  posture per table as registry one-liners instead of hand-rolled `pg_policies`
  catalog SQL. `rlsEnabled` requires `FORCE ROW LEVEL SECURITY` by default,
  because an unforced table fails open for its owner — waive it per table with
  `{ requireForced: false }`.

### Fixed

- `VERSIONING.md`'s public-surface list named the tenancy seam as `TENANCY_MODE` +
  `lib/tenancy/client.ts` — a file that has never existed. The covered seam is, and
  always was, `TENANCY_MODE` + the `lib/db/client.ts` chokepoint. Forks that went
  looking for `lib/tenancy/` were chasing a phantom module.

## [0.11.2] — 2026-08-31

> **Alpha release.** Sixteenth tagged Sunrise release. **PATCH bump** — a
> developer-experience patch, and the first cut since 0.11.1 that changes no
> runtime behaviour at all. Everything here is toolchain: the local lint/format
> caches, the CI lint job, and a coverage gate that was quietly not applying to
> a whole class of file. No migration, no schema change, no public API change.
>
> ## What a fork has to do
>
> **Nothing is required, but read item 3 if you have `.mjs` files.**
>
> **1. Your lint and format caches moved to the repo root** (#677). They were
> under `.next/cache/`, which meant `rm -rf .next` — the reflex fix for any
> stale-build symptom — silently destroyed them and bought you a cold run
> later, somewhere else. They are now `.eslintcache` and `.prettiercache`, both
> gitignored and dockerignored, and `npm run clean:cache` clears them
> deliberately. Measured on a 4,414-file fork: a cold `npm run lint` is 5.5
> minutes against 2.5s warm. **If you own your own `ci.yml`**, update the lint
> job's `actions/cache` paths to match, or CI pays for a cold run forever
> without ever failing.
>
> **2. `CI_LINT_CHUNKS` is available if your lint job OOMs** (#687). It defaults
> to `1`, which is exactly the whole-tree `eslint .` you already run, so doing
> nothing changes nothing. It exists for after `CI_NODE_HEAP_MB` runs out of
> room — a private `ubuntu-latest` is an 8GB box, so ~6144 is the ceiling, and a
> cap above physical RAM turns a clean V8 abort into an OS OOM kill. `npm run
> lint:ci` runs the same file set as N sequential eslint processes, so the job's
> peak is the largest chunk rather than the whole tree. Measured on a
> 4,527-file fork at cap 6144, cold: 1 chunk **6.36GB, OOM**; 4 chunks 5.20GB,
> fine. Raise it when lint aborts with **exit 134**:
>
> ```bash
> gh variable set CI_LINT_CHUNKS --body 4
> ```
>
> The cost is wall-clock, not money — every chunk rebuilds the ~2.6GB TypeScript
> program, which took that fork's cold lint from 1m23s to 6m51s and left warm
> runs unchanged. `.github/workflows/lint-memory-probe.yml` re-measures the
> table on your own runner; a laptop cannot, since three runs of one identical
> command there spanned 1.31GB.
>
> **3. `.mjs` files are now covered by the per-file 80% coverage floor, and were
> not before.** This is the one item that can newly fail a PR of yours. The
> scoped test runner filtered changed paths to `.ts`/`.tsx`, so every `.mjs` in
> the tree bypassed the gate #647 added — silently, which is the failure mode
> that runner exists to prevent. If your fork has `.mjs` under a path coverage
> does not exclude, the first PR that touches one will now be held to 80%. Two
> upstream files that would otherwise have been caught by this are excluded
> deliberately in `vitest.config.ts` — `scripts/spikes/**`, and
> **`lib/app/eslint.config.mjs`, the fork-owned ESLint seam**, so that editing
> your own seam cannot fail a coverage gate on a file Sunrise ships empty.
>
> **4. Two new workflow files arrive; neither needs anything from you.**
> `pr-cache-cleanup.yml` (#681) deletes the Actions caches a closed PR leaves
> behind, which otherwise sit against the repo's cache quota until they age out,
> evicting entries `main` still wants. `lint-memory-probe.yml` (#687) is
> dispatch-only and gates nothing. Called out because the first is the kind of
> file a fork notices while auditing workflow permissions: it declares top-level
> `permissions: {}` and grants `actions: write` to its single job, because
> deleting a cache entry is the one thing it does. It is gated to same-repo pull
> requests, since a fork PR's token is read-only and cannot be granted that
> scope — deliberately **not** solved with `pull_request_target`, which would
> hand a privileged token to a workflow triggered by an untrusted branch.

### Added

- **`CI_LINT_CHUNKS` — a repo variable that lowers what lint *needs*, once
  raising `CI_NODE_HEAP_MB` has run out of room.** Knob 2 raises the ceiling;
  this is the lever for after the ceiling becomes the machine, since a private
  `ubuntu-latest` is an 8GB box and a cap above physical RAM turns a clean V8
  abort into an OOM kill. `npm run lint:ci`
  (`scripts/ci/chunked-lint.mjs`) lints the same file set as N sequential
  eslint processes, so the job's peak is the largest chunk rather than the whole
  tree — verified against this tree as exactly what `eslint .` lints, 2,340
  files, none lost or gained. (It enumerates *tracked* files via `git ls-files`;
  a CI checkout has nothing untracked, so the two runs are identical there.) **Defaults to 1 — exactly today's whole-tree `eslint .`** — because base
  Sunrise has never approached its heap ceiling and each chunk re-pays the ~2.6GB
  TypeScript Program. A downstream fork of 4,527 lintable files peaked at 6.36GB
  and OOM'd at a 6144 cap; at 4 chunks it completes at 5.20GB. Raise it with
  `gh variable set CI_LINT_CHUNKS --body 4` when lint aborts with exit 134.
  Sequential chunks in one job rather than a job matrix, because Actions bills
  per job rounded up to the minute and a fan-out pays N checkouts and N
  `npm ci`s for setup it throws away. `npm run lint` is unchanged for local use.
  A dispatch-only `lint-memory-probe.yml` re-measures the table on your own
  runner. See [`.context/architecture/ci.md`](./.context/architecture/ci.md)
  Knob 4.

### Fixed

- **`.mjs` files bypassed the per-file coverage floor entirely.** The scoped
  test runner's `coverageTargets` filtered changed paths to `.ts`/`.tsx`, so
  every `.mjs` in the tree fell out of the ≥80% per-file gate #647 added —
  silently, which is the failure mode that runner is written against.
  `scripts/ci/**` is deliberately *not* excluded from coverage, so
  `scripts/run-capped.mjs`, `scripts/dev-server.mjs` and the new
  `scripts/ci/chunked-lint.mjs` are ordinary unit-tested tooling the gate simply
  could not see; the fork that found it measured a new `.mjs` at 78.66% lines
  with `/pre-pr` reporting PASS. Widening the filter made two structurally-0%
  files reachable, so both are now named in `vitest.config.ts`'s
  `coverage.exclude`: `scripts/spikes/**`, and — load-bearing for forks —
  `lib/app/eslint.config.mjs`, the fork-owned ESLint seam Sunrise ships as
  `export default []`, which a fork must be able to edit without failing a
  coverage gate.

## [0.11.1] — 2026-08-25

> **Alpha release.** Fifteenth tagged Sunrise release. **PATCH bump** — a
> same-day hotfix. 0.11.0 shipped better-auth 1.7.1 without the column that
> version requires, and took sign-in down for **every** user on **every**
> provider: Google and email/password alike. Nothing about it was visible from
> inside the codebase, and it passed a green test suite, a green CI run and a
> successful deploy on its way out.
>
> ## What a fork has to do
>
> **Take this before anyone tries to log in.** If you are on 0.11.0, new
> sign-ins are failing right now. Existing sessions are not — session validation
> never reads `account` — so the damage is bounded to people logging in, which
> is also why it can go unnoticed for a while.
>
> **Applying the migration is the whole upgrade** if you run stock Sunrise.
> Deployments that run migrations for you (Vercel, the #583 Docker migrator)
> need nothing further.
>
> **If you configured a social provider other than Google, read the fork note
> below before you deploy** — the migration deliberately refuses to guess that
> provider's issuer, and a refusal leaves a failed migration that blocks every
> later deploy until it is cleared.
>
> **Your sync merge should also stop failing its own coverage gate** ([#671]).
> That was Sunrise's debt being billed to you, and the floor now measures what
> you wrote rather than what the merge carried in.

### Fixed

- **Sign-in was broken in 0.11.0 for every user — Google *and* email/password.**
  0.11.0 bumped better-auth 1.6.29 → 1.7.1 ([#665]), which re-keyed account
  identity from `(providerId, accountId)` to `(issuer, accountId)`, but the
  `Account` model was never given the new `issuer` column. Every 1.7 sign-in
  path selects it, so both flows failed closed against a 0.11.0 database: the
  Google callback threw `Unknown argument 'issuer'` out of
  `findAccountOwnerByKey`, and email/password sign-in failed on the same missing
  column. Existing sessions were unaffected — session validation never reads
  `account` — so the failure was confined to new sign-ins. Local `.test`
  development did not catch it because `.test` domains cannot be used with
  Google, and a stale `node_modules` was still serving 1.6.29.
- **A fork's sync merge no longer fails `npm run test:changed:coverage` on
  Sunrise's own coverage debt** ([#671]). The per-file 80% floor asks "is what
  you changed tested" — but on a sync merge the fork changed nothing, so it was
  demanding a fork either fail its own pre-PR gate or write tests for platform
  files `CUSTOMIZATION.md` asks it not to diverge on. Measured against 0.11.0:
  6 such files syncing from v0.9.0, ~15 from v0.7.0, ~16 from v0.5.0. The floor
  now lands on what the branch **authored** (its own first-parent, non-merge
  commits, plus staged and working-tree files); test *selection* still uses the
  whole diff, so a merge that breaks upstream's tests still fails. An ordinary
  feature branch has no merges and is gated exactly as before, and the run
  prints `not authored here N` rather than narrowing in silence.
- `scripts/ci/check-client-env-delivery.ts` had no test — the one exception to
  `scripts/ci/`'s 24-of-24 convention, and it shipped in the same release as the
  check that flags exactly this shape. Now covered at the wiring level.
- `scripts/db/**` joins `scripts/smoke/**` in the coverage `exclude`. Both are
  CLI entrypoints that talk to a live database; nothing imports them, so they
  are absent from a full coverage run entirely and surface at 0% only when a
  scoped run forces them in. `*-assertions.ts` stays gated in both trees.

### Added

- `Account.issuer` (`String`, required) with `@@unique([issuer, accountId])`,
  matching better-auth ≥ 1.7. `issuer` is the authority that vouched for the
  subject — `local:credential` for email/password, the verified OIDC issuer
  (`https://accounts.google.com`) for Google, `local:oauth:<encoded providerId>`
  for an OAuth2 provider with none of its own. `providerId` remains a column but
  is local configuration and is **no longer an identity key**. Migration
  `20260825120000_add_account_issuer` backfills existing rows.
- `CREDENTIAL_ACCOUNT_ISSUER` in `lib/auth/constants.ts` — the issuer any code
  writing a credential `Account` outside better-auth must set.

> **Fork action.** Applying the migration is enough if you run stock Sunrise
> (Google and/or email/password). **If you configured any other social provider,
> extend `20260825120000_add_account_issuer` before deploying** — it raises on a
> `providerId` whose issuer it does not know rather than guessing one, because a
> wrong issuer does not fail loudly, it just strands those users at the login
> screen. It also raises if two rows would collide on `(issuer, accountId)`.
> Either abort leaves the migration recorded as failed, so every later deploy
> stops with P3009 until you clear it with
> `prisma migrate resolve --rolled-back 20260825120000_add_account_issuer` (on
> Neon, prefix `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=true`) — worth knowing if
> your platform runs migrations as part of the deploy. Adding a provider *after*
> the migration has run needs no change at all; never edit an applied migration.
> See [`.context/auth/oauth.md`](./.context/auth/oauth.md#account-identity-issuer-accountid).

[#665]: https://github.com/human-centric-engineering/sunrise/issues/665
[#671]: https://github.com/human-centric-engineering/sunrise/issues/671

## [0.11.0] — 2026-08-25

> **Alpha release.** Fourteenth tagged Sunrise release. **MINOR bump** — the
> fork-friction release. Every defect here was found by merging a real fork or by
> building a real container image; none of them was visible from inside the
> codebase, and several passed a green test suite while shipping.
>
> ## What a fork has to do
>
> **BREAKING: three env vars are removed.** `NEXT_PUBLIC_APP_NAME`,
> `NEXT_PUBLIC_LEGAL_NAME` and `NEXT_PUBLIC_APP_DESCRIPTION` no longer do
> anything. Move the values into `lib/app/brand.ts`. If you miss it, a boot
> warning names each variable still set, so the migration announces itself rather
> than quietly reverting your brand to "Sunrise".
>
> **Then pin what you filled**, as for any seam — `tests/unit/lib/app/defaults.test.ts`
> asserts each one ships empty, so its `lib/app/brand.ts` row fails the moment you
> set a value. Change the row rather than deleting it; see the FORK NOTE at the
> top of that file.
>
> **If you have files under `/app` or `/framework`**, declare those tiers in
> `lib/app/reserved-tiers.ts` and pin that row in `defaults.test.ts` too. That is
> the fix for the two 0.10.0 tests four of the five known forks failed on merge —
> including on the `/framework` rows, which the issue had assumed were safe
> because a leaf fork does not use them, but Daybreak is the framework-layer fork
> and fails exactly those.
>
> So: **two edits if you only rebrand, four if you also occupy a tier.** Measured
> by doing it, not estimated. Nothing else in the release asks anything of a fork.
>
> **No migration.** Zero migrations and no `prisma/schema/` change since 0.10.0,
> so the code side is a plain `git merge v0.11.0`.
>
> ## Read this if you deploy with Docker
>
> Two defects were invisible from inside the codebase and showed up only in a real
> container build. Brand identity reached no build at all, so a fork with its legal
> entity correctly configured still shipped `© <year> Sunrise` in both footers —
> proved by building 0.10.0, where the configured name appears zero times and
> "Sunrise" 74 times in the server bundle. And eight of nine `NEXT_PUBLIC_*`
> variables had no delivery path, so **analytics and error reporting were off on
> every self-hosted deploy regardless of configuration**, with no error, nothing
> above `debug`, and nothing visible in CI. Both are fixed, and both are now
> guarded so the class cannot return silently.

### Added

- **`lib/app/brand.ts` — brand identity as committed code** (issue [#661]). A
  fork-owned scaffold exporting `appBrandName`, `appBrandLegalName` and
  `appBrandDescription`, all `null` upstream, read by `lib/brand.ts`. Vanilla
  Sunrise is byte-for-byte unchanged; a fork sets three values in one committed
  file and every brand surface follows — page titles, both footers, the header
  `<BrandMark>`, the root meta description, and every transactional email.

  Note `appBrandDescription` reaches fewer surfaces than you might expect: every
  shipped *page* and route-group layout declares its own `description`, so the
  root fallback is what `app/not-found.tsx` and the root `error.tsx` /
  `global-error.tsx` serve — the 404 and error pages — plus any page a fork adds
  that declares none. Worth setting: those are precisely the pages nobody thinks
  to check.

- **`lib/app/reserved-tiers.ts` — a fork declares which reserved tiers it occupies**
  (issue [#660]). Ships `[]` upstream, so `tests/unit/reserved-fork-tiers.test.ts`
  runs all five rows against Sunrise itself exactly as before.

  That test enforces "Sunrise core creates nothing under the `/app` and
  `/framework` tiers" by asserting the directories are empty. Upstream that is the
  promise being kept. In a fork the same directories are the space the fork was
  *told* to fill, so the assertion is unsatisfiable and the failure message blames
  core for files core never created. **Four of the five known forks fail it on
  `git merge v0.10.0`** — and not only on the `/app` rows: Daybreak is a
  framework-layer fork and fails the two `/framework` rows for the same reason, so
  this was never a leaf-fork-only concern. `reserved-fork-tiers.test.ts` is in
  `ALWAYS_RUN_TESTS`, so a fork's suite is red from the merge commit onward until
  it edits a Sunrise-owned test file. (`layout-metadata.test.ts` is added to that
  list by this release — on v0.10.0 it surfaces only in a full run, not in a
  scoped pre-flight.)

  Declaring subtracts only the tiers you occupy, so the rest keep guarding. The
  test rejects a name that is not a reserved tier — a typo would otherwise read as
  a working declaration while the row it was meant to silence still failed — and
  fails if you declare a tier you have left empty, so the declaration is
  self-cleaning rather than accumulating.

- **`npm run check:client-env` — a delivery guard for client variables** (issue
  [#662]), wired into `npm run validate`. Scans the source for
  `process.env.NEXT_PUBLIC_*` and fails when one lacks an `ARG`/`ENV` pair in the
  `Dockerfile` or a build arg in `docker-compose.prod.yml`.

  It keys on **"is it `NEXT_PUBLIC_`"** rather than "is it required", which is what
  the old hand-maintained list got wrong. The scan is also co-extensive with what
  Next actually inlines: the compiler needs the static `process.env.NEXT_PUBLIC_X`
  form, so anything the regex misses the compiler misses too and was never
  delivered anyway. Bracket-access reads are reported separately, since a build arg
  cannot help them.

  Fork-tolerant by design: a missing `Dockerfile` or `docker-compose.prod.yml` is
  skipped rather than failed, so a fork that deploys only to a dashboard platform
  is not handed one more core check it cannot satisfy.

### Changed

- **`tests/unit/app/layout-metadata.test.ts` derives its module list instead of
  hand-listing it** (issue [#660]). The list was seven literal module specs behind
  a `length >= 7` staleness floor, and both halves were wrong. It was **already
  incomplete upstream** — `(public)/contact`, `(public)/privacy` and
  `(public)/terms` all export metadata and none were listed, so the floor guarded a
  list that had never been complete. And it was **unfixable in a fork**: deleting
  the placeholder About page, which `CUSTOMIZATION.md` §6 explicitly invites and
  two forks have already done, produced an unresolvable import rather than an
  assertion failure, after which removing the dead row broke the floor. Reading
  `app/` off disk takes the modules actually checked from 7 to **76** — 87 route
  modules are discovered, of which 76 export a static `metadata` object — and
  retires the floor, since a derived list cannot go stale. The remaining 11
  include four that use `generateMetadata`, which needs route params and a live
  database; the hand-listed version did not cover those either, and the test says
  so rather than counting them.

  Two rows are now fork-aware. The brand-leak row skips a route module that
  re-exports from a tier declared in `lib/app/reserved-tiers.ts` — metadata reached
  through a fork's own tier is its copy, not a leak of ours — and it is
  deliberately the only row exempted: the starter-template row runs everywhere,
  because no fork means to advertise a starter template. Measuring the forks says
  that split is right, since two of them are shipping exactly that text today from
  an About page they never rewrote. The title-doubling row now respects Next's own
  `title.absolute` semantics, which opt a page out of the parent template — a fork
  that ships its own home page commonly uses it, and the row was unsatisfiable for
  them.

### Removed

- **BREAKING: `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_LEGAL_NAME` and
  `NEXT_PUBLIC_APP_DESCRIPTION`** (issue [#661]). Setting them now does nothing;
  brand identity comes from `lib/app/brand.ts`.

  **To upgrade:** move the three values from your `.env` into `lib/app/brand.ts`
  and delete the env vars. That is the whole migration.

  These are removed rather than deprecated because they were never a working
  mechanism with a gap in it. `NEXT_PUBLIC_*` is inlined by the compiler at build
  time, `.dockerignore` excludes `.env` and `.env.*`, and the Dockerfile forwards
  only the four build args whose absence *fails* the build — the brand vars are
  optional, so their absence was silent. On a container build they delivered
  nothing at all, and every affected fork was already shipping `© <year> Sunrise`
  while believing itself configured. Keeping them as a fallback would have meant
  documenting, in five files, an escape hatch that silently fails on the
  deployment path most forks use.

  A deploy-time-varying brand — a staging name distinct from production — is no
  longer supported. That case was already broken everywhere except Vercel.

### Fixed

- **`NEXT_PUBLIC_*` variables now reach a container build** (issue [#662]). Eight
  of the nine could not, so **analytics and error reporting were off on every
  self-hosted deploy regardless of configuration** — no error, nothing above
  `debug`, and nothing visible in CI.

  `NEXT_PUBLIC_*` is inlined by the compiler during `next build`; setting one on a
  built image does nothing, and `.dockerignore` excludes `.env` and `.env.*`, so a
  build arg is the only channel. The Dockerfile's own comment stated the rule that
  produced the gap — *"required for Next.js build and environment validation"*,
  i.e. **forward what fails the build**. That is right for every variable except
  the class whose absence fails *silently*: client vars are all optional, so
  exactly one was forwarded, and only because it happened to also be required.
  Server-side secrets were never affected — they are runtime reads that `env_file`
  supplies, and they must not become build args.

  The eight are now wired through `Dockerfile`, `docker-compose.prod.yml` and CI,
  and `NEXT_PUBLIC_SENTRY_DSN` / `NEXT_PUBLIC_COOKIE_CONSENT_ENABLED` are
  registered in `lib/env.ts`, having been read straight from `process.env` and
  declared nowhere.

- **Blank environment values are treated as unset.** Found by building the image
  rather than by any test: a Dockerfile `ENV VAR=$VAR` whose `ARG` was not passed
  materialises as the **empty string**, and Zod's `.optional()` accepts `undefined`
  but rejects `''`. Wiring the client vars therefore broke `next build` outright
  for anyone who had not set all nine — which is every fork — on `"Invalid URL"`
  for the two `.url()` hosts. `lib/env.ts` now drops blank values before parsing.

  **Scoped to `NEXT_PUBLIC_*` deliberately.** Blank-is-unset is right where Docker
  gives no way to distinguish the two, and wrong everywhere else: applying it to
  the whole environment would have turned `SIGNUP_MODE=""` — what a deploy
  template produces from an unset source — from a boot refusal into a silent
  `.default('open')`, so an invite-only deployment would have come up accepting
  public signups. `TENANCY_MODE`, `MCP_SESSION_MODE` and `CAPABILITY_BINDING_MODE`
  had the same exposure. Server vars still fail loudly on a blank.


[#660]: https://github.com/human-centric-engineering/sunrise/issues/660
[#662]: https://github.com/human-centric-engineering/sunrise/issues/662
[#661]: https://github.com/human-centric-engineering/sunrise/issues/661

## [0.10.0] — 2026-08-24

> **Alpha release.** Thirteenth tagged Sunrise release. **MINOR bump** — the
> fork-seam release. Five new `lib/app/*` seams (API-key scopes, account
> sections, evaluation graders, MCP resources, the footer attribution line),
> `components/app/**` and `components/framework/**` reserved and enforced, a
> fork tier able to declare its own Art. 15 subject-data sources, and one
> shared init gate behind the lazy seams so a fork's failing `initApp*()` can
> no longer leave half its registrations live.
>
> **No migration.** Zero migrations and no `prisma/schema/` change since 0.9.0,
> so a fork takes this with a plain `git merge v0.10.0` and no database step.
>
> **Security — read this section even if you skip the rest.** The
> outbound-redirect class that #628 opened is now closed. Five more sites
> validated their target exactly once and then followed `Location` unchecked —
> among them the webhook **test** route, which carried its HMAC to the final
> hop and reported that hop's status as the endpoint's, and the knowledge
> embedder, which would have posted uploaded document text to an unvalidated
> host. `executeHttpRequest` no longer follows redirects either, and every
> server-side `fetch()` must now declare a `redirect` policy, enforced by a
> guard that enumerates the call sites mechanically — the hand-written roster
> it replaced was wrong by three, which is the failure mode such a roster
> exists to prevent. Separately, **minting *or revoking* an API key now
> requires a browser session**: both verbs accepted a key of any scope, so a
> narrowly-scoped key could mint a `chat` key and reach every authenticated
> route as its owner, or enumerate and revoke its owner's keys including
> `admin`. And `GET /api/health` no longer discloses the Sunrise platform
> version — unauthenticated, it named the exact upstream release, and therefore
> the exact set of published issues, for *every* Sunrise-derived deployment
> rather than one.
>
> **Breaking-in-`0.x` changes — read before you merge.** `sunrise` is **gone**
> from the `GET /api/health` response; read `system.sunriseVersion` from
> `GET /api/v1/admin/stats`, or import `SUNRISE_VERSION` server-side. **MCP
> sessions are stateless by default** — the old per-process session `Map` meant
> `initialize` minted an id on one instance and the next call 404'd on another,
> unrecoverable by retry; set `MCP_SESSION_MODE=stateful` if you need the SSE
> stream or the three continuity methods on a single long-running process.
> **Tests run on `node` by default**, with a DOM opt-in per file, so a fork's
> own component tests fail with `ReferenceError: document is not defined` on
> the first run after merging — `npm run fix:dom-tests` migrates them by
> running them rather than by pattern-matching. **A fork-owned schema file must
> now account for every model it declares**, each one named as a subject-data
> source or excluded with a reason. `ApiKeyScope` is an open type and
> `validateScopes` returns a plain `boolean`;
> `CreateExposedResource['resourceType']` is now `string`.
>
> **If you took any 0.10.0 pre-release commit, check your landing page.** For
> five days `main` shipped `app/(public)/page.tsx` as a byte-identical copy of
> `app/(public)/about/page.tsx`, so `/` served the About page. It is fixed
> here, and the cause is worth knowing because it is not page-specific: a flat
> backup directory keyed by **basename**, in a tree with 82 files called
> `page.tsx` and 228 called `route.ts`. The same mechanism made
> `/api/health` return the admin stats payload two days later. A structural
> guard now fails when any two route modules under `app/` are byte-identical.
>
> **Cost attribution.** Four fixes, all the same shape — spend that was
> recorded but not attributable. Workflow capability spend sat against no step,
> `llm_call` rows were untagged, a zero-token row could capture a step's model,
> and a capability row did not say which capability it was. Separately, the
> rolling chat summary was being **recomputed on every turn** past the history
> window — a fresh summarisation of the whole dropped region, on the agent's own
> provider — and its cost row discarded by a double foreign-key violation, so
> nothing on the Costs page moved. Repeated and invisible at the same time.
>
> **Testing and CI, for anyone who runs the suite.** `npm run test:changed` is
> the new `/pre-pr` default: it runs what the branch can affect and gates
> coverage per changed file at 80%, rather than on a repo average that clears
> while a new file sits at 0%. The full suite is unchanged and remains CI's
> backstop.

### Added

- **`npm run fix:dom-tests` — the migration aid for a fork merging the
  node-by-default test environment (#649).** That change carries directives for
  Sunrise's test files and none for a fork's own, so on the first run after
  merging, every fork-authored component test fails with
  `ReferenceError: document is not defined`. Measured across the five forks on
  this machine: 1233 fork-authored test files, ~350 needing a directive — too
  many to annotate by hand.
  It **decides by running, not by pattern**. Sunrise's own migration used a
  static classifier and it was wrong in both directions: it over-declared 69
  files (matching the English words "knowledge _document_", "context _window_")
  and missed one entirely, whose DOM need lived in the source under test behind
  a `typeof` guard. A directive is written only for a file that **failed**, and
  kept only if the re-run **shows that file passing** — presence in the passed
  list, never absence from the failed one, since a path missing from a report
  may simply not have run. Anything it cannot justify is reverted before it
  exits, and it refuses a run that collected nothing at all
  (`numTotalTestSuites: 0`, what a typo'd path produces): that previously
  printed "no failure was caused by a missing browser global" and exited 0
  having run nothing. It never edits a file that already
  declares an environment, and it reports, without touching, the two groups it
  is not entitled to fix: real failures (Node's `fetch`/`Response` are stricter
  than happy-dom's, so some are bugs the old environment hid) and files that
  already ask for a DOM and fail anyway. `--dry-run` previews.
  `.context/testing/environments.md` gains the fork merge recipe this belongs
  to, including the one category nothing automated finds — a test whose
  *subject* touches the DOM behind a `typeof` guard, which passes on node while
  silently taking the server branch.

- **`/admin/overview` shows which Sunrise a deployment is running.** A
  `SystemInfo` card (`components/admin/system-info.tsx`) renders the fork's app
  version beside the Sunrise platform release it is built on, plus Node version
  and environment — the answer to "did that upgrade actually ship?" and to
  "which Sunrise are you on?", which until now needed a terminal.
  `GET /api/v1/admin/stats` gains `system.sunriseVersion` to feed it (see the
  Security entry). The card is a
  **server component** taking the stats payload as a prop, so the overview page's
  existing fetch feeds it — no client bundle, no second request, no hydration —
  and forks inherit it without editing a Sunrise-owned route.
  The whole `system` block of the stats payload was previously API-only, so
  `appVersion` had no UI consumer at all. Two details worth knowing if you adapt
  the card: the platform row is labelled **"Sunrise platform"**, not "Sunrise",
  because upstream `BRAND.name` *is* `"Sunrise"` and `APP_VERSION` equals
  `SUNRISE_VERSION` — a bare label renders the same word over the same number
  twice, and only a rebranded fork would ever notice; and a `null` stats payload
  renders an explicit "unavailable" message rather than an empty card, because
  `getStats()` returns `null` on any fetch failure and a broken stats API must
  not look like a healthy deployment on the page an operator opens *because*
  something is wrong. (#531)

- **`npm run test:changed` / `npm run test:changed:coverage` — a scoped local
  test gate, and the new default for `/pre-pr`.** The full suite is ~1080 files
  and roughly four minutes with coverage; two of them running at once across
  checkouts saturates a 10-core machine (measured: one run holds ~3.2 cores).
  The scoped pair runs the tests the branch can affect — vitest's own
  `--changed` selection against the merge base, uncommitted and untracked work
  included — and gates coverage on the **changed source files at 80% each**
  (`thresholds.perFile`) rather than on the repo average. Measured on a 10-core
  machine for a 20-file selection: ~5s wall idle, ~23s with another suite
  competing — about half of it the `vitest list` pre-pass that resolves the
  selection. `npm run test:coverage`'s own measured figure is 254s of in-vitest
  time. A project-wide average is the wrong question for a
  per-PR gate — it clears comfortably while a newly added file sits at 0%; a
  changed file with no test now reports **as 0%** rather than being absent from
  the report.
  The selection is unioned with `ALWAYS_RUN_TESTS` (`scripts/ci/scoped-tests.ts`),
  the tests whose subject is the repository rather than a module —
  `export-sources` (the Art. 15 manifest guard), `reserved-fork-tiers`, the
  fork-init seam roster, the outbound-redirect roster, the ESLint app boundary.
  Nothing imports `prisma/schema/*.prisma`, so no module graph reaches them and
  `--changed` would never select them; a scoped run without that union would
  silently stop enforcing exactly the rules this repo leans on hardest. The list
  is hand-written with a reason per entry because all three candidate detectors
  miss things, measured at 8167a36f — by fs-API name (22 found, misses 3), by `node:fs` import (16,
  misses 9), by repo-rooted read (14, misses `eslint-app-boundary.test.ts`,
  which reads the tree through ESLint and imports no filesystem module). A
  detector runs alongside as an **advisory** that prompts you to declare a new
  one; it is not a completeness guarantee and says so.
  Fails loudly rather than quietly: an unresolvable base ref, a failed
  `vitest list`, a signal-killed vitest, and a selected path that cannot be
  passed to vitest safely all exit 1, because a stale base produces a short file
  list and a short list is a quiet green. That last one covers two shapes a
  security review surfaced: a filename containing a newline, which `vitest list`
  prints across two lines so the second fragment can arrive as its own argv
  token (vitest reads options wherever they appear, so a fragment like
  `--config=x.test.ts` would replace the run's whole config, `setupFiles` and
  coverage `exclude` included); and a git C-quoted path, which stops ending in
  `.ts` and would otherwise fall out of the coverage list in silence. `origin/main` is
  fetched by default (`--no-fetch` opts out). The full-suite scripts are
  unchanged — a scoped run cannot prove the branch broke nothing elsewhere, and
  CI's `test-full` job (4-way sharded, every PR and every push to `main`)
  remains the backstop. Note for forks running `CI_TEST_SCOPE=changed`:
  `test-full` is skipped on PRs there and the `test-changed` job runs a bare
  `vitest --changed` with no always-run union, so the whole suite lands only
  after merge; the docs carry the one-line workflow change that closes it.
  Coverage includes are glob-escaped — `(protected)` and `[...all]` are
  picomatch syntax, so an unescaped route-group path matched no file, gated
  nothing and exited 0. See
  [`.context/testing/scoped-runs.md`](./.context/testing/scoped-runs.md).

- **A capability can declare that a persisted `scope` binds its arguments
  (#586).** `CapabilityContext.scope` has shipped since 0.5.0 as a carrier —
  threaded from an MCP key, a workflow execution or a nested `run_workflow`, and
  handed to `execute()`. It could not *do* anything: every scoped capability
  consumed it by hand, or a fork patched the dispatch path. Now a capability
  opts in at registration — `register(cap, { scopedBy: 'projectId' })` — and the
  dispatcher fills that argument when the caller omits it (step 4b) and refuses
  with `{ code: 'scope_conflict' }` when the caller names a different value. A
  key minted with `scope: { projectId: 'x' }` makes `projectId` ambient **and**
  makes it a boundary.

  **Two conditions, both defaulting to off.** The capability must declare the
  binding, and the caller's scope must be one the platform wrote
  (`scopeIsAuthoritative`). The four sites that build a dispatch context each
  spread `platformScope()` or `hintScope()` — the MCP key carrier and the two
  workflow executors take the first, `POST /api/v1/chat/stream` takes the
  second, because its `scope` comes from an untrusted request body. A mistake in
  either direction loses the binding rather than gaining one, and
  `run_workflow` drops a hint scope rather than passing it to
  `engine.execute()`, so the persisted `AiWorkflowExecution.scope` column never
  holds a consumer's hint. Note for fork adapter authors: the inbound-trigger
  route merges an adapter's `normalise()` scope under the operator's static
  one, so a bound value there can originate from a verified request payload
  rather than from config — more restrictive than no key at all, but worth
  knowing.

  **The binding is declared rather than inferred**, which is the whole design.
  An earlier cut read it out of the capability's published
  `functionDefinition.parameters` and armed whenever a scope map was present;
  that is admin-editable JSON which need not agree with the Zod schema the
  author wrote, and "a scope map exists" is a different question from "this tool
  is scoped". Declaring it also makes the gaps visible: measured against the
  fork that asked for this, inference covered 19 of its 29 capabilities and none
  of its nine `featureId`-keyed writes, with nothing to say which were which.

  **The invariant is re-asserted after validation** (step 7a), on the args
  `execute` actually receives, because `handler.validate()` is a Zod *pipeline*
  and may transform — three built-ins wrap their schema in
  `z.preprocess(unwrapApprovalPayload, …)`, which merges an `approvalPayload`
  object over the top level. Each pinned key must be **present and equal**;
  a stripped key or unreadable args (a `Map`, a class instance, anything behind
  an accessor — all of which answer `hasOwnProperty` with `false`) are refused
  with the second new code, `scope_unenforceable`. **The limit, stated because
  it cannot be fixed:** only top-level own properties are inspected, so a
  capability resolving its scope from a child id must not declare `scopedBy` for
  it — that check belongs in `execute()` or a `guard`.


- **`npm run check:missing-tests` — `/pre-pr` step 4f stops being prose.** Twelve
  of step 4's thirteen anti-pattern checks were prose, so every agent hand-rolled
  a scanner on every run — and a hand-rolled scanner's failure mode is *silence*,
  which is indistinguishable from a pass. The instance that prompted this used
  `compgen` (a bash builtin) in a zsh agent shell: the loop printed nothing and
  was nearly banked as a clean tree. 4f is now a tested script, and it answers in
  **three** verdicts rather than two: `covered`, `missing`, and — the one a
  mirror-path check gets wrong — `referenced only`, for a module no mirrored test
  covers but some test names. Measured over every tracked `.ts`/`.tsx` — 2301 files, 1146 of
  them non-exempt — **367 have no mirrored test, and 258 of those are covered
  some other way**: 240 named by a test file, 14 by the collapsed parent of a
  dynamic route, 4 by an aspect-named sibling. Only 109 are genuine gaps, so a
  two-answer check is wrong about 258 files in one direction or the other.
  Exemptions are decided by the TypeScript compiler where a filename cannot
  decide them — 14 `index.ts` files here carry their own code, and exempting
  every barrel by name hides 9 that have no test; 16 more declare no runtime
  value and are exempt for the opposite reason.
  It **reports and never gates on a finding**; exit `1` means only that it could
  not run, and it runs a sentinel through the classifier before every real scan,
  so a clean result is never printed by a scanner that cannot report a dirty one
  (#641).

- **`npm run check:changelog-drift` — a CHANGELOG bullet that a later commit
  made untrue.** `/pre-pr` step 5d asks whether a public-surface change is
  *missing* an entry and stops there; in a multi-round PR the likelier failure
  is a bullet that was accurate when written and was falsified by a later commit
  on the same branch. It fired six times on one PR (#625), and all six passed
  5d because `CHANGELOG.md` was in the diff. The new check correlates the
  identifiers a bullet quotes in backticks against the commits that changed
  those strings afterwards — **per line, not per bullet**, so a partial rewrite
  cannot make an older claim look fresh — and separately flags any commit SHA in
  `[Unreleased]` that is not reachable from `origin/main`, because a branch SHA
  stops resolving the moment the PR is squash-merged. It is wired into `/pre-pr`
  as step 5e and **never gates**: the correlation is a heuristic, and it cannot
  see a claim that was already wrong when written, or one that is stale by
  omission, or tell a commit that *changed* an identifier from one that merely
  mentioned it in a comment. Bullets an earlier PR left in `[Unreleased]` are
  reported behind their own heading, because every commit on the branch counts
  as later for those. All of it is stated where the check is run.

- **`lib/fork-init.ts` — one shared gate behind the lazy `lib/app/*` init seams.**
  `createAppInitGate({ label, subject, init, snapshot, restore })` owns the
  latch, the rollback, the log line and the log-safe error description — and
  `ensure()` never throws, structurally: its body is wrapped, so a `snapshot` or
  `restore` closure that fails cannot escape a public read on eleven registries,
  several of which are documented as always-safe-to-call. A seam that returns a
  **promise** is also called out at boot (`… must be synchronous, and the
  all-or-nothing rollback does NOT apply`), with its rejection routed to the log;
  `@typescript-eslint/no-misused-promises` already fails such a seam at lint, so
  this is the backstop for a fork that does not lint. Eleven of
  the thirteen `initApp*` seams run through it; the two that do not —
  `initAppNav`, called at module scope from a client component, and `initApp`,
  the boot hook that registers nothing itself — are pinned as exemptions with
  their reasons by `tests/unit/fork-init-seams.test.ts`. That test derives the
  seam list from `lib/app/`, fails when a new seam hand-rolls the gate, and diffs
  the roster in
  [`.context/architecture/fork-init-seams.md`](.context/architecture/fork-init-seams.md)
  against the code in both directions rather than leaving it maintained by hand —
  a prose roster is how #633 came to name four of the seven broken seams.

- **`overrideReasons` in `package.json` — an `overrides` change now has somewhere
  to answer.** `check:lockfile` gated on any change to the `overrides` block and
  ended with the word "Intentional?", which is a question a build cannot be told
  the answer to; wired into branch protection, its only routes past were
  bypassing the protection or weakening the rule. A per-key override transition
  now passes when that key's `overrideReasons` entry **moved in the same diff**.
  "Moved", not "exists": a reason landed in an earlier PR cannot wave a later
  change through, and a revert has to restate its case. Removing an override
  means removing its reason too. Reasons for keys a diff did not touch are never
  read, so a fork inheriting the whole upstream block is unaffected — the
  fork-sync breakage that sank the previous attempt (#584) cannot recur here.
  Forks with their own overrides should add a reason for each; nothing fails
  until one of them is next added or re-pointed. Removing an override that never
  had a reason is deliberately allowed — there is nothing to move, and failing
  it would fail forks for state they inherited from before the block existed.

- **`lib/privacy/subject-source-registry.ts` + `initAppSubjectSources()` — a
  fork tier declares its own subject-access sources.** The Art. 15 coverage
  guard scanned every `prisma/schema/*.prisma`, including the fork-reserved
  `app.prisma` and `framework-*.prisma`, but checked them against a manifest
  only core can write to — so a fork that filled `collectAppSubjectData()`
  exactly as documented still had a red core test and no fork-owned way to green
  it. `registerAppSubjectSources({ tier, sources, excluded })` is that way. A
  registry rather than one exported constant because `CLAUDE.md` reserves two
  fork tiers, and a single slot means a framework tier consumes the seam its
  leaf forks are entitled to. Skipping the reserved namespaces would have been
  smaller and was rejected: it trades a noisy false positive for a silent false
  negative, and an access request cannot survive silence. Vanilla Sunrise
  declares nothing and is unchanged.

- **`DeclaredAppSourceMissingError` (`lib/privacy/export-user.ts`).** Thrown when
  a tier declared a source whose `section` `collectAppSubjectData()` did not
  return — including one set to `undefined`, which `JSON.stringify` drops from
  the delivered bundle. Return the key with an empty array when the subject owns
  nothing; a bundle short by a section reads exactly like a complete answer,
  which is what this module's "a partial export is worse than no export" rule
  already said. Cannot fire in vanilla Sunrise, where nothing is declared.

- **`meta.app` — a fork tier's declared sources are summarised for the subject.**
  Each declared source contributes `{ model, section, disposition, description,
  rows }`, so a section under `app` is named and counted in the bundle's own
  manifest the way core's are. Its own list rather than folded into
  `meta.exported`, because an `exported` entry's `section` is a key of
  `personalData` and these are keys of `app` — folding them would send a reader
  looking in the wrong object. Empty in vanilla Sunrise.

- **A fork tier's exclusions are disclosed to the data subject.**
  `bundle.meta.excluded` now carries the registry's `excluded` rows alongside
  core's, so a fork table withheld from an export is named with its reason on
  the same terms as `AiMessageEmbedding`. Without it a fork install's bundle
  stated the boundary for core's tables and stayed silent about the fork's, and
  a subject could not tell "we hold nothing about you" from "we decided not to
  give it to you". No bundle shape change — the row type is identical — so no
  `EXPORT_FORMAT_VERSION` bump.

- **`lib/app/api-key-scopes.ts` + `withAuth(handler, { scope })` — least
  privilege is available to forks.** `AiApiKey.scopes` is a `String[]`, but the
  two places deciding what may go in it were closed lists in platform files, so
  a fork could *check* a scope of its own and no user could ever *create* one to
  check. `APP_API_KEY_SCOPES` unions into both. The enforcement half ships with
  it, because a wider scope list on its own is just labels: `withAuth` accepted
  a key of any scope, so the key on someone's phone reached every authenticated
  route as them. `{ scope }` applies to API-key callers only — a browser session
  is the full user — and is opt-in per route, so no shipped endpoint changes.
  `GET /api/v1/user/api-keys` now also returns `availableScopes`. (#542)

- **`lib/auth/api-key-scopes.ts`** — the scope vocabulary
  (`CORE_API_KEY_SCOPES`, `validateScopes`, `hasScope`, `listValidApiKeyScopes`,
  `ApiKeyScope`), split out of `lib/auth/api-keys.ts` so `createApiKeySchema`
  can read it without dragging Prisma into the client bundle. `api-keys.ts`
  re-exports all of it, so existing imports are unchanged.

- **`lib/app/account-sections.ts` + `lib/account-sections/registry.ts` — extra
  sections on `/profile` and `/settings`.** The account surface is where a fork
  commonly adds an account connection, a billing panel or an integrations list,
  and it had no extension point — so the only way in was editing a
  Sunrise-owned page and conflicting on every sync. `registerAccountSection({
  id, surfaces?, order?, Component })` renders at the foot of either page (or
  both, the default); `Component` receives `{ userId }`. The account-surface
  analogue of `lib/admin-nav/registry.ts`. Empty registry renders no node at
  all, so vanilla Sunrise is unchanged, and a throwing init rolls back anything
  it had already registered rather than half-rendering the account surface. (#595)

- **`lib/app/evaluations.ts` — fork-owned evaluation graders.** The grader
  registry advertised pluggability that only held for core: `registerGrader` was
  exported, but the only caller was the package's own barrel, and the batch
  worker runs in the **route** realm — so a grader registered from `initApp()`
  filled a map the worker never read. It either never reached the metric picker
  or threw `No grader registered for slug` mid-drain, after the subject calls
  were already paid for. `initAppGraders()` now runs once, lazily, before the
  registry's first lookup, so every route-realm reader sees it. Replacing a
  built-in slug still works (that is how a mock is swapped in) but is now logged
  at warn. A throwing init **rolls back** the registrations it had already
  made — otherwise a grader that had shadowed `exact_match` would keep rescoring
  every run while the log said none were registered. (#541)

- **`lib/app/mcp-resources.ts` — fork-owned MCP resource handlers.** MCP *tools*
  had a fork seam (`lib/app/capabilities.ts`); *resources* did not, so a
  read path a host could preload had to ship as a tool call. Fill in
  `initAppMcpResources()` with
  `registerMcpResourceHandler({ resourceType, uriScheme, handler })` and an app
  type flows through `resources/list|read|subscribe`, templates, caching,
  `resources:read` scoping, `McpExposedResource` gating and audit exactly like a
  core one. `uriScheme` is required — a fork resource silently inheriting
  `sunrise://` would advertise the starter's identity to every MCP client that
  lists it — and a built-in `resourceType` cannot be shadowed. The scheme binds
  to the type: `sunrise://…` filed under a fork type is a 400, and so is the
  inverse (`isUriSchemeValidForResourceType`, `mcpResourceUriSchemeFor`). A
  throwing init rolls back its own partial registrations, so a half-configured
  resource is never left dispatchable. Rows still default to
  `isEnabled: false`. (#563)

- **`components/app/**` and `components/framework/**` are now reserved fork
  tiers.** Sunrise creates nothing under either, so a fork's own React
  components merge cleanly on upgrade. This closes a live collision: the
  reserved list previously named only `.context/app/`, `lib/app/**` and
  `prisma/schema/app.prisma`, while forks were already shipping
  `components/app/` — if Sunrise had ever added a file there it would have
  landed on top of fork code. Note the difference in kind from `lib/app/`,
  which ships *scaffolds* you fill in: `components/app/` ships **nothing**, and
  you invent the structure. It exists because `lib/app/**` must stay
  framework-agnostic (no runtime framework imports, no `react-dom`), so every
  seam there is data and a component cannot live there. Enforced by
  `tests/unit/reserved-fork-tiers.test.ts`. (#561)

- **`lib/app/footer.ts` — `footerCopyright`.** The footer attribution line is now
  fork-owned: `null` keeps the platform default (`© {year} {BRAND.legalName}`),
  a string replaces it verbatim, `false` renders nothing. Read by **both**
  `PublicFooter` and `ProtectedFooter` so they cannot drift. `false` is the
  white-label case — a public surface that is an end-user artefact rather than a
  marketing site, where naming the platform operator is a leak rather than a
  credit. The **Cookie Preferences** control is unaffected and remains
  non-overridable. (#561)

- **`BRAND.description`, backed by `NEXT_PUBLIC_APP_DESCRIPTION`.** The root
  `<meta name="description">` for any page that does not set its own. Defaults
  to the product name rather than a sentence — a wrong sentence is worse than a
  short one. (#519)

- **`ChatInterface` endpoint props: `streamEndpoint`, `transcribeEndpoint`,
  `deleteConversationEndpoint`.** All default to today's admin routes, so
  existing callers are unchanged. A non-admin surface — a consumer page, or an
  app-owned route pinning `contextType`/`contextId` server-side — can now reuse
  the component. Its docblock also names which features are admin-only
  (`showInlineTrace`, the cost/token strip, approval cards) so a fork can decide
  what to turn off rather than concluding it must rebuild. `CHAT_TRANSCRIBE` is
  now registered in `lib/api/endpoints.ts` rather than living as a string
  literal in the component. (#526)

### Fixed

- **The public landing page was serving the About page.**
  `app/(public)/page.tsx` had been replaced wholesale with a byte-identical copy
  of `app/(public)/about/page.tsx`, so `/` and `/about` rendered the same hero,
  the same body copy and the same `title: 'About'`. `Pricing` and `FAQ` were
  left exported from `components/marketing/index.ts` and rendered by nothing.
  It shipped to `main` and would have shipped in this release.
  The page is restored, and its metadata carries the change the clobbering
  commit intended but did not apply: `title: 'Home'`, with the layout's
  `%s - ${BRAND.name}` template supplying the brand once.

  **How it happened, because the mechanism recurs.** A flat backup directory
  keyed by **basename**. In an App Router tree `page.tsx` and `route.ts` are not
  distinctive names — this repo has 82 of the first and 228 of the second — so
  `cp <several paths> "$TMP"/` keeps exactly one of each, and the restore writes
  it back over every path it came from. The commit that did it was editing
  `page.tsx` and `about/page.tsx` together: the small intended edit to
  `about/page.tsx` landed (6 lines), and `page.tsx` received about's whole file
  (331 lines) instead of its own 3-line change.
  The same mechanism hit `app/api/health/route.ts` two days later, which took
  the **stats** route's content and became an admin-guarded endpoint returning
  user counts. Both were verified after restoring — by diffing against the
  backup, which is corrupted-compared-against-corrupted, an assertion that
  cannot fail in the one place whose job is to notice. `npm run validate` passes
  either way: a clobbered route is a real, valid module, just the wrong one.

  **The guard is structural, not content-shaped**
  (`tests/unit/app/route-module-distinctness.test.ts`, registered in
  `ALWAYS_RUN_TESTS`): no two route-segment modules under `app/` may be
  byte-identical — `page`, `layout`, `route`, `error`, `loading`, `not-found`,
  `template`, `default` and `global-error`, 325 of them today. It catches both
  incidents above and needs no opinion about what any page *says*, which matters
  because the marketing pages are fork-owned placeholders: a core test pinning
  their content would be a core test a fork cannot satisfy, the #480 / #525 /
  #530 / #533 class this release closes four instances of. That is also why
  Sunrise still ships **no** content test for the landing page, and says so in
  the file. A fork with a genuine collision appends to the exported
  `ALLOWED_IDENTICAL_GROUPS` rather than editing the guard, so the merge stays
  additive the way `ALWAYS_RUN_TESTS` already is; it ships empty upstream, and a
  third file joining a declared group still fails. Its reach is byte-identity
  and no further — a copy that renames the default export passes.
  **Forks:** if you merged the affected range and had not yet rewritten your
  landing page, take this file wholesale; if you had, keep yours.

- **The rolling conversation summary was recomputed on every single turn past
  the history window, and the cost row for each of those calls was silently
  discarded (#654).** Two defects that concealed each other. The reuse check was
  `conversation.summaryUpToMessageId === lastDroppedId`, where `lastDroppedId`
  is `history[droppedCount - 1].id` — the **boundary of a sliding window**.
  `droppedCount` grows by about two a turn (one user message, one assistant), so
  turn 1 pinned the message at index 1 and turn 2 asked about index 3. The check
  could not hit in normal use: past roughly 25 exchanges (`MAX_HISTORY_MESSAGES`
  is 50 *messages* — `tool` rows count too), **every turn** paid for a fresh
  summarisation of the whole dropped region, on the agent's own provider.
  Meanwhile `summarizer.ts` logged that spend with `agentId: 'system'` and
  `conversationId: 'summary'` — literal strings into two columns that are real
  foreign keys — so each insert violated both, `logCost` caught the P2003 and
  returned `null`, and the call was `void`-ed. Nothing on the Costs page moved;
  the only signal was one error line per summary and the provider invoice.
  The fix changes the model rather than the comparison. The summary covers a
  **prefix** of the conversation, `summaryUpToMessageId` names the newest message
  in it, and reuse asks whether that prefix already contains everything this turn
  has to drop. Because the boundary moves every turn, staying reusable means
  summarising **past** the requirement: `SUMMARY_LOOKAHEAD_MESSAGES` (10) buys
  roughly five turns per call at the default cap. (Not at every cap: at
  `maxHistoryMessages` of 1–3 the clamp below leaves a lookahead of 0 or 1, so
  those agents still summarise every turn. Inherent — a two-message window
  cannot both summarise ahead and keep the last exchange — and each call is now
  a ~2-message fold rather than a full re-derivation.) The handler now passes `historyDropCount` to
  `buildMessages` so the summary boundary **is** the drop boundary — two
  independently-computed boundaries that had to agree is the shape that produced
  the bug, and nothing appears in the prompt both summarised and verbatim.
  Verbatim history consequently sits between
  `cap - min(10, floor(cap / 2))` and `cap` messages: **the lookahead never
  takes more than half the window.** That clamp is load-bearing, not defensive —
  `maxHistoryMessages` is validated `min(0).max(500)`, so a cap below the
  lookahead is supported, and an unclamped 10 summarised an agent with
  `maxHistoryMessages: 4` down to *zero* verbatim history — losing the assistant
  turn the user was replying to — on roughly every third turn. At the default
  cap of 50 it is `min(10, 25)` = 10, so the reuse win is untouched.
  `summarizeMessages` gained `previousSummary` and **extends** rather than
  re-derives, so a call costs what was *added* since the last one, not the length
  of the conversation. That also fixes a quieter loss: `loadHistory` returns at
  most 200 rows, so anything older used to leave the prompt and the summary
  together — the folded text now outlives the rows. (With one limit, pre-existing
  and not changed here: an agent whose `maxHistoryMessages` is at or above that
  200-row window never summarises at all, because nothing is ever dropped for
  the cap. Those conversations lose everything past 200 rows silently, as they
  did before. Filed as #655.)
  Three failure-path defects found by review and fixed with it: an empty
  completion (a content filter, or a reasoning model spending its token budget
  before emitting text) discarded the stored summary instead of falling back to
  it; rows whose `summary` column holds the placeholder — which the pre-fix code
  persisted unconditionally, so they exist in the wild — were treated as real
  and would have been folded forward indefinitely; and a stored summary whose
  pin has scrolled past the 200-row load window is now rendered without an
  invented count rather than dropped from the prompt entirely.
  A `fellBack` result is never
  persisted, which stops one transient provider error replacing a good summary
  with `[Summary unavailable]` and recording it as covering messages nothing
  describes.
  Embedding cost rows were the third part: recorded, counted in global totals,
  attributable to nothing. `embedText`/`embedBatch` take an optional
  `EmbeddingAttribution`, filled in by the `search_knowledge_base` capability
  (with the `isWorkflowAgentId` guard, since a workflow's `context.agentId` is a
  synthetic label and not an `AiAgent.id`) and by the `rag_retrieve` executor
  (`workflowExecutionId` + the carrier's `stepId`, which both execution cost
  readers filter on). Ingestion paths stay unattributed by design — no agent or
  conversation exists behind a document upload — and carry `metadata.kind`
  instead. All parameters are optional; forks calling these directly are
  unaffected.
  This was the **third** time a non-row-id reached one of those foreign keys
  after #599 and #600, so it also ships a guard:
  `tests/unit/lib/orchestration/llm/cost-log-fk-attribution.test.ts` derives
  every `logCost` call site in the tree and compares what each writes into
  `agentId` / `conversationId` / `workflowExecutionId` against a written
  allowlist, registered in `ALWAYS_RUN_TESTS`. A literal check alone would have
  caught this one and **neither** of the other two, which passed ordinary
  expressions that hold a workflow label on some paths — so the guard is a
  roster compared by set equality, and a new call site fails it until someone
  states why its value is a row id. Its limit is documented and was measured:
  it reads `logCost` call sites, so a value reaching a foreign key one hop away
  through a forwarding function is invisible to it — deleting the workflow guard
  in `search-knowledge.ts` leaves it green. Each forwarding hop has its own
  behavioural test instead.

- **Workflow capability spend now shows up against the step that caused it, and
  `agent_call` tool spend shows up at all.** #599 stopped these `AiCostLog` rows
  being lost to an FK violation; they existed after it and were still invisible
  in both places an operator looks. `CapabilityContext` gains a third optional
  carrier, `costLogMetadata`, merged **under** the dispatcher's own keys
  (`{ ...context.costLogMetadata, slug, success }`) so a caller cannot overwrite
  `slug` — which the per-capability stats route groups on — or hide a failure by
  setting `success`. The executors apply the same rule one level up
  (`{ ...ctx.costLogMetadata, stepId: step.id }`), so a run cannot misattribute
  its own rows to a different step.
  Two things ride on it. **`stepId`**: both execution readers do
  `const stepId = extractStepId(row.metadata); if (!stepId) continue;`, so every
  capability row was dropped from the execution detail and live cost panels, and
  `loadPastRuns` could not attribute it either. **Evaluation tags**: a run stamps
  `{ evaluationRunId, role }` on `ExecuteOptions.costLogMetadata`, and those
  stopped at the capability boundary.
  `agent_call` also gains `workflowExecutionId`, which it never passed. The
  asymmetry was inside one file — that executor's own LLM `logCost` set it while
  the capability dispatch beside it did not — so a tool an agent invoked
  mid-workflow recorded an `agentId` and a null execution link and never
  appeared against the run. (#600)

- **`llm_call` cost rows were untagged too, and `send_message_to_channel` was
  still losing rows outright.** Both found by enumerating every `logCost` call
  site rather than by reading #600, which named neither — it asserted
  `llm-runner.ts` already forwarded the carrier, and it does not.
  `runLlmCall` wrote `metadata: { stepId }` and nothing else, so an evaluation
  run's tags were missing from every LLM step, not just from tool calls.
  `send_message_to_channel` writes its own `OUTBOUND_MESSAGE` cost row and did
  so with `agentId: context.agentId` unconditionally — which from a workflow
  `tool_call` step is the synthetic `workflow:<id>` label, not an `AiAgent.id`.
  That is the identical P2003 data loss #599 fixed at the dispatcher, still live
  in a built-in because the dispatcher's guard does not cover a capability's own
  `logCost` call: **every outbound message sent from a workflow recorded no cost
  row at all.** Both now apply the guard and the merge.
  Three more boundaries turned up the same way, each found by checking a site
  rather than reading the issue. `chat/streaming-handler.ts` threaded
  `request.costLogMetadata` into its own four `logCost` calls but not into the
  dispatch context, so an agent evaluation — which runs its subject through that
  handler — tagged the subject's LLM spend and left every tool it called
  untagged. `engine/executors/judge-call.ts` **deliberately** withheld it, under
  a comment asserting the executors already tag those rows; they do not, because
  `driveJudgeAgent` logs through the chat handler rather than an executor, so
  evaluating a workflow with a `judge_call` step tagged every step except the
  judge. And `run-workflow` did not pass it to the child execution, so a nested
  workflow's rows were untagged.
  `.context/orchestration/capabilities.md` now carries the full roster of
  boundaries and what each owes — including the one that correctly forwards
  nothing, and the orchestrator-delegation case that remains unattributed. The
  rule is stated as a question to ask at a new boundary, not as a count, because
  the count has been wrong every time anyone has written one down. (#600)

- **A zero-token cost row can no longer capture a workflow step's model
  fingerprint.** `loadPastRuns` picks each step's dominant model with
  `bestTokens = -1` and `>`, so when every candidate ties at zero the winner is
  whichever row was inserted first. Giving `agent_call` dispatches a `stepId`
  puts the dispatcher's `model: 'n/a'`, 0-in/0-out row under the same step id as
  that step's LLM rows — and if those turns also reported zero usage, an `'n/a'`
  winner made `runMatchesFingerprint` reject the **entire** past run, silently
  degrading the estimator to heuristic once enough runs fell below
  `EMPIRICAL_MIN_SAMPLES`. Zero-token rows are now skipped, which is safer
  rather than merely narrower: a step left with no fingerprint entry is treated
  as no signal and skipped, not as a mismatch. (#600)

- **A capability cost row now says which capability it was.** The execution
  detail and live panels project `metadata.slug` into their `CostEntry`, and the
  per-call cost table renders it in place of the model column. Capability rows
  are all `capability/n/a` with 0 tokens and $0, so making them visible without
  this turned an `agent_call` step that invoked five tools into five identical,
  information-free rows — a cost table saying nothing about cost. LLM rows are
  unchanged and still identify themselves by `provider/model`.
  Three cases are documented as **known exceptions** rather than fixed, in
  `.context/orchestration/capabilities.md`: the judge path's row carries no
  execution link because the chat handler sets none; orchestrator delegations
  stamp a synthetic step id no panel can match; and
  `send_message_to_channel` renders `$0.0000` because its model string is not in
  the registry and `logCost` takes no cost override. Each needs a wider change
  than this one. (#600)


- **A fork init that threw kept the registrations it had already made, while
  logging that the feature was disabled.** Six seams — `jobs`,
  `context-contributors`, `guard-floor-contributors`,
  `guard-event-contributors`, `knowledge-access-contributors` and
  `user-created` — caught the throw, said "disabled", and left everything
  registered before it live. A job kept running on every maintenance tick (and
  held the idle gate open at its interval) from a config its author believed had
  not loaded; a knowledge-access contributor kept widening a restricted agent's
  document set, which is the only direction those can move; a user-created hook
  kept provisioning, emailing or billing every new account. All six now roll
  back to the pre-init registry, so the message is literally true. A second
  latent bug went with it: `String(err)` throws on a null-prototype value, and
  only one of the eleven seams guarded it. In the nine others that had a catch,
  the log call itself could throw and escape it — after the rollback, in the
  three that had one — surfacing as an unexplained failure of the very thing the
  catch protects (#633).

- **One misdeclared app capability stopped the fork's others from registering.**
  `capabilityDispatcher.register()` throws on an authoring mistake
  (`processesPii = true` with no `redactProvenance()` override) and it threw
  mid-flush, so a fork with 28 registrations and a bad one at position 12 got 11
  in the dispatcher, 16 never reached, and every dispatch path throwing. The
  flush now isolates per entry: the failing capability is named in the log and
  skipped, the rest register. One case is not a clean skip and says so — when the
  failed registration was replacing an existing slug via `register(cap, { slug })`,
  the handler it was replacing stays live *without the fork's guard*, so it logs
  that rather than "skipping it". **A throwing `initAppCapabilities()` itself still
  re-raises** rather than degrading like the other seams — rollback costs the
  fork its whole toolset, and an agent missing every tool answers from its own
  weights with nothing marking the gap — but it is now latched before it runs,
  so it no longer re-runs on every chat turn and every workflow step for the
  life of the process (#633).

- **Core tests a fork could not satisfy (#480, #525, #530, #533).** Filling a
  seam correctly turned the suite red in four places: the subject-access
  coverage guard (above), the capability registry's idempotency count (which
  reported "expected 13, got 27" under a test named *is idempotent*, sending the
  reader after a double-registration bug in wiring that was already correct),
  twelve test cases across eight files that wrote `/dashboard` and `Dashboard`
  instead of importing `AUTH_LANDING_ROUTE` / `AUTH_LANDING_LABEL` — measured by
  filling the seam and running the **whole** suite, which is now down to the one
  intended `SEAM_DEFAULTS` pin — and
  `smoke:export`. `tests/unit/fork-seam-coupling.test.ts` now requires any core
  artifact reading a `lib/app/*` seam unmocked to carry a `FORK NOTE`.

- **Four proxy assertions compared a redirect with `toContain('/dashboard')`,**
  which matches a query string or a longer path — and for a fork landing on `/`
  matches every URL there is. They compare the parsed pathname exactly now,
  which is stronger for vanilla Sunrise too.

- **A parameterised MCP resource URI now matches when its `{param}` is not the
  last path segment.** `hub://projects/{id}/plan` collapsed to
  `hub://projects//plan` under the strip-then-`startsWith` test, which no
  concrete URI starts with, so the read returned `null`. Every core template
  happens to be trailing, which is why nothing noticed. The prefix test is kept
  alongside the new exact-fill test, so every URI that resolved before still
  resolves.

- **Timers are cancelled on unmount across 19 components.** Every unmanaged
  `setTimeout` in `components/**` — one not stored in a ref that a cleanup
  clears — outlived the component
  that scheduled it. The dominant case — "hide the success banner after N
  seconds" — is a state update React discards, so it looked harmless; two were
  not. `chat-interface`'s follow-up poll re-queued itself indefinitely after
  unmount, because `streamingRef.current` freezes at its last value and nothing
  else terminated the chain, and its reconnect backoff held a timer for up to
  four seconds past teardown. A new `useTimeout()` in `lib/hooks/` schedules
  work that is cleared on unmount. It matches `setTimeout` in one deliberate
  respect and diverges in another: scheduling twice still leaves two independent
  timers, but **after unmount `schedule()` is a silent no-op**. That is what
  makes an uncancellable timer impossible, and it is the behaviour to know about
  before reaching for the hook — an effect that genuinely must outlive its
  component wants a bare `setTimeout` and its own cleanup. **A fork that has
  overridden any of these components carries the same defect**; the affected
  files are listed in [#625](https://github.com/human-centric-engineering/sunrise/pull/625).

- **CI test jobs no longer inherit `CI_NODE_HEAP_MB` once per worker.**
  `NODE_OPTIONS: --max-old-space-size` is set at workflow level and is a
  **per-process** cap, but `test-full` and `test-changed` fork roughly
  `cores - 1` workers apiece — so the real ceiling was `workers × the knob`. At
  the 5120 default that is ~15.4GB on a 4-vCPU/16GB public runner; at 8192 — the
  value `ci.md`'s own worked example recommended until this release, four lines
  above a rule forbidding it — ~24.6GB on the same runner. That example is now
  6144, so **a fork still carrying 8192 should re-derive its floor by
  bisection** rather than assume the value was chosen for its codebase. **The documented remedy for one job was the trigger for
  another**, and the failure it produced was an OS OOM kill rather than a clean
  V8 abort — surfacing as `Failed to start forks worker`, or as a shard quietly
  missing from the file count. Both test jobs now opt out of it, taking Node's
  own memory-derived default. Every other job still inherits it — the
  single-process ones it was sized for (`typecheck`, `lint`, `build`) and the
  rest (`smoke`, `docker`, `lockfile`), none of which fork workers. A new `CI_TEST_NODE_HEAP_MB` gives
  the test jobs their own knob for the case Node's default is not enough; unset
  (the default) means no flag at all, and it must be sized per worker rather
  than per runner. **Forks that have
  raised `CI_NODE_HEAP_MB` should re-read
  [`.context/architecture/ci.md`](./.context/architecture/ci.md) — and lower it
  to fit before flipping a repo private**, where `ubuntu-latest` is 2 vCPU / 8GB.

### Removed

- **BREAKING: `sunrise` is gone from the `GET /api/health` response.** Also
  removed from `HealthCheckResponse` (`lib/monitoring/types.ts`) and
  `healthCheckResponseSchema` (`lib/validations/monitoring.ts`). Anything reading
  `body.sunrise` from that endpoint — an uptime monitor asserting on it, a
  deploy-verification script grepping it — breaks. Read
  `GET /api/v1/admin/stats` (`system.sunriseVersion`) instead, or import
  `SUNRISE_VERSION` server-side. `version` is unaffected. **Why** is under
  Security below; this entry exists so a fork scanning `Removed` for upgrade
  breakage finds it. (#531)

### Security

- **`GET /api/health` no longer discloses the Sunrise platform version.** The
  `sunrise` field is **removed** from the response — a breaking change to a
  documented public surface, and the reason is that the surface was public.
  The endpoint takes no authentication (verified: it is absent from `proxy.ts`'s
  `protectedRoutes`, and the handler carries no guard), so the field named the
  exact upstream release a deployment runs, and therefore the exact set of
  published issues to try against it, to anyone who asked. Unlike a fork's own
  app version, that answer is useful against **every** Sunrise-derived
  deployment rather than one.
  It is now served from `GET /api/v1/admin/stats` as `system.sunriseVersion`,
  behind `withAdminAuth`, and rendered on `/admin/overview` — see the Added
  entry above. `version` (the fork's `package.json` version) **stays** on the
  health payload: it is the fork's own number to disclose, it means nothing
  outside that fork, and container health checks and deploy-verification scripts
  read it.
  `HealthCheckResponse` (`lib/monitoring/types.ts`) and
  `healthCheckResponseSchema` (`lib/validations/monitoring.ts`) drop the field
  with it. The schema **tolerates** a payload that still carries one — Zod's
  default object behaviour strips unknown keys — so a fork that keeps `sunrise`
  on its own health route, and a rolling upgrade serving both shapes at once,
  both keep working against `useHealthCheck`. **What breaks:** anything reading
  `body.sunrise` from `/api/health` — an uptime monitor asserting on it, a
  deploy script grepping it. Read `/api/v1/admin/stats` instead, or import
  `SUNRISE_VERSION` server-side.
  `tests/integration/api/health.test.ts` now asserts the **exact** top-level key
  set rather than a list of `toHaveProperty` calls. The old form could only
  catch a field going missing, never one appearing, which is how this one sat
  there unquestioned; every future field is now a decision someone has to take
  deliberately.
  A whole-tree guard (`tests/unit/sunrise-version-disclosure.test.ts`, added to
  `ALWAYS_RUN_TESTS`) holds the invariant that actually matters: **no
  unauthenticated route's import graph reaches `SUNRISE_VERSION`**. Three routes
  still return it — admin stats, the MCP settings route, and the
  `POST /api/v1/mcp` `initialize` handshake — and all three are authenticated.
  The guard computes that roster by walking the tree rather than listing it,
  because the hand-written version of that roster was wrong while this very
  change was being written: it named one route and missed two, one of them
  reached through two hops of imports. (#531)

- **Five more outbound sites refuse redirects, closing the class #628 opened.**
  Each validated its target exactly once and then followed `Location` headers
  unchecked. `webhooks/[id]/test` was a one-line divergence from
  `webhooks/dispatcher.ts` on the *same* `webhook.url`, and because
  `X-Webhook-Signature` is a custom header name the fetch spec does not strip
  cross-origin, the HMAC travelled — while the admin UI reported the final hop's
  status as the endpoint's, so a moved endpoint read as healthy.
  `knowledge/embedder.ts` would have posted uploaded document text to an
  unvalidated host. `llm/provider.ts`'s `fetchWithTimeout` is set as
  defence-in-depth: both its production callers pass hardcoded hosts today, but
  it is an exported generic wrapper and so the seam a fork reuses with a
  configured host.
  **And both vendor SDK clients, which no sweep had found** — `llm/openai-compatible.ts`
  hands the admin-set `AiProvider.baseUrl` to `new OpenAI({ baseURL })`, and
  `llm/anthropic.ts` passes no `baseURL` at all yet the SDK defaults it to
  `ANTHROPIC_BASE_URL`, so pointing it at a gateway is one env var away. Neither
  SDK sets a redirect policy, so undici followed every hop carrying the prompt —
  and Anthropic authenticates with `x-api-key`, a custom header name the spec
  does **not** strip cross-origin, so its key travelled too. Both are fixed with
  a `fetch` wrapper rather than by trusting SDK defaults, which also returns
  them to the view of
  `tests/unit/lib/security/outbound-fetch-redirects.test.ts` — that scan sees
  literal `fetch(` calls only, which is how they survived three sweeps. The
  wiring is pinned by a per-client unit test, since deleting the wrapper would
  remove the literal call from the scan along with it.
  **A provider or webhook endpoint that answers 3xx now fails instead of being
  followed; re-point it in config.** The guard's `KNOWN GAP` rows are gone, and
  its docblock now states what it cannot see (#635).

- **The embedding path re-checks its provider URL at the point of use.**
  `callEmbeddingApi` read `AiProviderConfig.baseUrl` straight from Prisma and
  called it. The only other guard is the Zod refine at create/update, which
  seeds, imports and direct DB writes bypass — which is precisely why
  `provider-manager.ts` already re-checks at its own point of use. So a
  seeded or imported row pointing at, say, the cloud metadata endpoint would
  have had uploaded document text POSTed to it on the **first** hop, which no
  redirect policy can help with. Now runs `checkSafeProviderUrl` with
  `allowLoopback` driven by the provider's `isLocal`, and throws before any
  request leaves (#635).

- **`executeHttpRequest` no longer follows redirects.** The orchestration HTTP
  executor validated its host allowlist once, against the initial URL, then
  called `fetch()` with no `redirect` option — so undici's default `'follow'`
  applied and every subsequent `Location` was unvalidated. #534 fixed four
  sibling sites and missed this one, because that sweep was scoped by grepping
  `checkSafeProviderUrl` and this site guards with an env host allowlist
  (`isHostAllowed`) instead. It is the sole path for
  the `call_external_api` capability, the workflow `external_call` step, and the
  Twilio / WhatsApp Cloud adapters — and the capability returns the response
  body to the model, making it a read primitive rather than a blind write.
  Auth travelled too: `bearer` and `basic` are stripped cross-origin by the fetch
  spec, but `api-key` with a custom header name is not, and `query-param` puts
  the secret in the URL. Now `redirect: 'error'`, matching the three siblings.
  **Exploitation always needed an operator to have set
  `ORCHESTRATION_ALLOWED_HOSTS` (unset by default, fail-closed) AND an
  allowlisted host to emit a redirect**, so this is hardening rather than an
  open door — but the rule is stated in `lib/security/safe-url.ts` and four of
  five sites already followed it. A newly-redirecting endpoint now fails
  non-retriably with `fetch failed: unexpected redirect` rather than being
  chased; re-point the URL in config.

- **Every server-side `fetch()` now declares a redirect policy, enforced by a
  test.** `tests/unit/lib/security/outbound-fetch-redirects.test.ts` enumerates
  the call sites mechanically and fails CI on one with no `redirect` option,
  carrying legitimate exemptions and known gaps as pinned rows. It replaces a
  hand-written roster which review found wrong by three — a list maintained by
  memory has the exact failure mode it was written to prevent. Writing the check
  turned up three further sites of the same class as this fix, now tracked as
  **#635**: `llm/provider.ts` and `knowledge/embedder.ts` (admin-set provider
  `baseUrl`, validated once) and the webhook **test** route, which follows
  redirects on the same URL its production dispatcher refuses them on, carrying
  an HMAC in a custom header the fetch spec does not strip.

- **Minting *or revoking* an API key now requires a browser session.** `POST`
  and `DELETE` on `/api/v1/user/api-keys` used `withAuth`, which accepts a key
  of any scope. Minting was privilege laundering — a key scoped to one narrow
  job could mint a `chat` key and reach every authenticated route as its owner,
  so least privilege that can self-escalate is not least privilege. Revoking is
  destructive rather than escalating, but `GET` returns every key's id, so a
  leaked `chat`-scoped key could enumerate its owner's keys and revoke all of
  them, `admin` included. Both now 403 for a key-authenticated caller,
  mirroring the existing refusals on `PATCH /api/v1/users/me` (email) and
  `GET /api/v1/users/me/export`. Browser sessions are unchanged, and no
  headless flow loses anything it still had — a rotate-and-revoke script needs
  `POST` too.

### Changed

- **Tests run on `node` by default; a DOM is opt-in per file.** Vitest builds a
  fresh environment per test file, and constructing a happy-dom Window means
  building the whole browser API surface — which two thirds of this suite never
  touches. A file that needs one declares it on its first line
  (an environment docblock on line 1); 405 files carry one, 682 run on node.
  Measured back-to-back on `tests/unit/lib` (434 files) under identical load:
  **49.3s wall / 141s CPU** against **58.1s / 191s** with happy-dom everywhere,
  and in-worker environment construction of **11.4s against 79.5s**. Read the
  CPU and environment figures rather than wall clock — wall moves with whatever
  else is running, aggregate work is what a shared machine is short of.
  **It is also a correctness fix.** happy-dom defines `window`, so `lib/env.ts`
  validated only the _client_ schema and every server variable read as
  `undefined` — anything branching on `TENANCY_MODE`, `CAPABILITY_BINDING_MODE`
  or `MCP_SESSION_MODE` was silently exercising the undefined path. 44 of the 47
  test files importing `@/lib/env` now see the real server schema (the three
  exceptions are two component tests and `env.test.ts`, which asserts on
  `typeof window` deliberately). The switch
  surfaced one such masked case: `successResponse(…, { status: 204 })` throws on
  Node's `Response` (204 forbids a body) and only ever "passed" because
  happy-dom's is lenient; nothing calls it that way, and the test now pins the
  real constraint.
  Getting it wrong is asymmetric: a DOM test on node fails loudly
  (`ReferenceError: document is not defined`), but a node test that picks up
  happy-dom **passes** and quietly rejoins the class of test this change exists
  to escape. `tests/unit/vitest-environment-directives.test.ts` guards the
  mechanical half (directive on line 1, no conflicting values, known environment
  name) and is registered in `ALWAYS_RUN_TESTS`; it cannot tell you a file did
  not need the DOM it asked for, and the docs say so. Vitest matches the
  directive **anywhere in a file**, so a comment merely discussing it applies
  it — that bit twice while writing this, once silently.
  The node default also needed a second network guard: `tests/setup.ts` refused
  real requests through happy-dom's fetch interceptor, which covered none of the
  node files. Both halves now exist and both now have tests; neither did before. Chosen as a docblock rather than
  `test.projects` because a projects config prefixes `vitest list` output with
  `[name] `, which would break `npm run test:changed`; `environmentMatchGlobs`
  no longer exists in vitest 4. **Forks:** the directive is per file, so it
  merges cleanly; a new component test that dies on `document is not defined`
  just needs the line. See
  [`.context/testing/environments.md`](./.context/testing/environments.md).

- **`MCP_SESSION_MODE` — MCP sessions are now stateless by default, so the
  handshake survives a function-per-request platform.** Sessions were held in a
  per-process `Map`: `initialize` minted an id on one instance, the client's next
  call was load-balanced to another, and that instance looked the id up in its
  own empty map and returned `404 Session not found or expired`. Observed on a
  production Vercel deploy — one session id, one instant, three instances, two
  404s and a 200. **No client retry recovers it**, because the session is not
  lost, it is invisible to live siblings, so re-initialising just repeats the
  race. The default issues no `Mcp-Session-Id`, which per the Streamable HTTP
  transport means the client never sends one, so there is nothing that can fail
  to be found.
  **What this costs you if you are on a single long-running process:** the SSE
  stream (`GET` answers `405 Allow: POST`), `resources/subscribe`,
  `resources/unsubscribe` and `logging/setLevel`, which refuse with a new
  `STATELESS_UNSUPPORTED` (`-32005`) rather than accepting work they would drop —
  and `initialize` no longer advertises them, so a conforming client does not
  ask. **Set `MCP_SESSION_MODE=stateful` to keep them.** That mode is a
  legacy-compatibility mode rather than a richer one: MCP revision `2026-07-28`
  removes protocol-level sessions and the `initialize` handshake outright and
  prescribes exactly what `stateless` does. **`stateful` is not needed to serve
  older clients** — that is backwards: `stateless` dispatches `initialize`
  normally and **connects** for every client `stateful` does, plus `2026-07-28`
  clients that `stateful` refuses with `400 Missing Mcp-Session-Id header`. Choose it
  for the SSE stream or the three continuity methods, on one process — plus one
  smaller difference: it remembers the negotiated protocol version, so a client
  that omits `MCP-Protocol-Version` on later requests keeps its `2025-06-18`
  tool annotations instead of falling back to `2024-11-05`.
  **Two operator-facing consequences of the default.** `Max sessions per key` in
  the admin MCP settings has no effect — nothing creates a session, so there is
  nothing to cap — and the admin Sessions page is always empty even while clients
  are connected. Both surfaces now say so rather than reading as a broken setting
  and an idle server. And note the startup guard fails the **whole app** build,
  not just MCP: it sits at module scope in a file the MCP barrel re-exports, and
  seven non-MCP admin routes reach that barrel transitively. Choosing `stateful` on a platform that announces itself (`VERCEL`,
  `AWS_LAMBDA_FUNCTION_NAME`) throws at startup with the fix in the message; that
  guard is a safety net, not a boundary — a multi-replica container deploy hits
  the same bug undetected (#609).

- **A fork-owned schema file must now account for every model it declares.**
  Any file in `prisma/schema/` that is not one of Sunrise's own eleven — not
  just `app.prisma` and `framework-*.prisma` — is treated as a fork tier's and
  held to full accounting: each model declared as a source, or excluded with a
  reason, rather than run through core's `userId`/`createdBy` heuristic. Core
  reads its own column vocabulary and cannot read yours, so a table keyed
  `authorId` or `respondentId` was invisible to that scan. No effect on vanilla
  Sunrise, where `app.prisma` ships empty.

- **`npm run smoke:export` asserts the app seam works rather than that it is
  untouched.** It checked `Object.keys(bundle.app).length === 0`, which
  implementing the seam makes false by construction — and the script is not in
  `validate` or `npm test`, so a fork got a green local run and a red pipeline.
  It now asserts every declared section arrived and is empty for a subject who
  owns nothing, which also catches a collector matching a stranger's rows.

- **`ApiKeyScope` is an open type and `validateScopes` returns `boolean`.**
  `ApiKeyScope` was a closed union and is now `CoreApiKeyScope | (string & {})`,
  which keeps autocomplete on the five core names while accepting a fork's.
  `validateScopes` consequently returns a plain `boolean` rather than the type
  predicate `scopes is ApiKeyScope[]` — against an open type that predicate
  narrowed nothing while reading as a guarantee it could not make. The runtime
  check is unchanged.

- **`CreateExposedResource['resourceType']` and
  `ListExposedResourcesQuery['resourceType']` are now `string`, and
  `createExposedResourceSchema.uri` no longer requires `sunrise://`.** Both
  schemas and both inferred types are exported, so a fork consuming them sees a
  weaker type. That is the type-level shadow of the validation change below —
  the *runtime* surface is equal-or-stricter, because membership moved to the
  route rather than being dropped.

- **MCP resource `uri` and `resourceType` are validated against what can
  dispatch, not against a closed enum.** `POST /api/v1/admin/orchestration/mcp/resources`
  now rejects a URI whose scheme nothing registered and a `resourceType` with no
  handler. This is strictly stricter than the Zod enum it replaces — that enum
  could not see a core type whose handler had gone missing — while letting a
  fork create `hub://projects/{id}/plan`. The Zod schema keeps a format check
  only; membership moved to the route because `lib/validations/mcp.ts` is
  imported by client components and the registry reaches `lib/app/`.

- **Metadata no longer hardcodes the starter identity.** `app/layout.tsx`
  shipped `"${BRAND.name} - Next.js Starter"` and a description advertising "a
  production-ready Next.js starter template"; `app/(public)/layout.tsx` shipped
  the same blurb again, and the landing and About pages hardcoded the literal
  `Sunrise` in their titles and social cards. All of it now comes from the
  `BRAND` seam, and the root title uses the object form so un-templated pages
  inherit `%s - ${BRAND.name}`. Route groups declaring their own
  `title.template` are unaffected.

  **Fixing the root layout alone is not enough, and that is worth knowing if you
  carry a patch here.** Next resolves metadata at the nearest segment that
  defines a field, so any route group declaring `description` overrides the root
  outright — all four of Sunrise's do. `tests/unit/app/layout-metadata.test.ts`
  is now on its **third** shape, because the first two both passed while the
  blurb was still live: v1 asserted on the root `metadata` object, which cannot
  see a route group's override, and v2 text-scanned
  `export const metadata[^;]*?;`, which any value hoisted into a module const
  escapes — exactly what the two remaining offenders did. Both guessed at
  *where* a leak might be written. v3 does not guess: it stubs
  `NEXT_PUBLIC_APP_NAME` to a value no fixture would produce, re-imports each
  metadata module, and reads the strings Next would actually serve. Anything
  still naming the product after that is hardcoded by definition — however it
  was spelled, hoisted, interpolated or computed.

  Page **body copy** remains fork-owned and deliberately out of scope — the seam
  covers the brand name, not marketing prose (see `lib/brand.ts`).

- **The public footer's copyright moved inline, and dropped ". All rights
  reserved."** It had a dedicated centred row costing ~44px; `ProtectedFooter`
  has always rendered the same content inline for free. Forks hosting no-login
  app surfaces in `(public)` — where vertical space is scarce — get that back
  with no configuration. The shorter wording matches `ProtectedFooter`; the
  phrase is legally inert under Berne, and because `legalName` falls back to the
  *product* name, the old default had personal and internal forks asserting all
  rights on behalf of a product rather than a company. Set `footerCopyright` to
  a string to restore any wording you want.

- **`npm run lint` runs under an explicit Node heap cap.** Node derives its
  default heap from machine RAM and stops there — 4288MB on a 16GB host,
  however much of the rest is free — and cold, whole-repo, type-aware
  `eslint .` needs ~4.1GB. Base Sunrise clears that by about 2%; **a fork with
  real code on top does not**, and it fails as `exit 134` (SIGABRT) with no
  message naming memory. Measured across the fork family: Sunrise 4.05 GiB and
  passing, two ~2,700-file forks aborting and needing 5120, a ~1.9x fork
  needing 6144. `lint` and `lint:fix` now go through `scripts/run-capped.mjs`,
  which appends `--max-old-space-size` to `NODE_OPTIONS` — **only when nothing
  has set one already**, so CI's `CI_NODE_HEAP_MB` stays authoritative and a
  fork's measured value is never silently replaced. `NODE_HEAP_MB` overrides
  the 6144 default locally; it is clamped to 75% of physical memory and floored
  at Node's own default, so on a machine too small for it the wrapper is a
  no-op rather than a downgrade. `type-check` and the pre-commit hook are
  deliberately **not** capped — measured at 1.64-1.75 GiB and 1.85 GiB
  respectively, both with a wide margin. See
  [`.context/architecture/lint-toolchain.md`](./.context/architecture/lint-toolchain.md#memory-why-lint-runs-under-an-explicit-heap-cap).

- **The test jobs no longer attach a Postgres service container.** `test-full`
  (×4 shards) and `test-changed` each started a `pgvector/pgvector:pg15`
  container and ran `db:migrate:deploy` + `db:seed` against a database **no test
  could reach**: `tests/setup.ts` is a global `setupFiles` entry and overwrites
  `DATABASE_URL`, so a query would have authenticated as a user the container
  never created. Measured at ~37s per shard against a 143s vitest step — ~2.5
  job-minutes on every push, plus a term in the test-job heap budget on the 8GB
  private runner where it is tightest. `smoke` keeps its container; it is the
  job that queries Postgres for real. Both test jobs keep `DATABASE_URL`, which
  `prisma generate` wants defined and never connects with. **A fork that has
  repointed `tests/setup.ts` at the CI database and added genuinely DB-backed
  tests will go red** — re-add the `services:` block and the two steps, both
  shown in
  [`.context/architecture/ci.md`](./.context/architecture/ci.md#the-postgres-service-container).

- **Tests in the happy-dom environment no longer touch the network.** happy-dom loads
  `<script src>` and `<link rel=stylesheet>` for real (both flags default to
  *off*), and resolves relative URLs against its default document origin,
  `http://localhost:3000` — so a full run made ~470 failed connections to a dev
  server that was not running. Both loaders are now disabled, and a
  `settings.fetch.interceptor` refuses any remaining request with the same
  error shape happy-dom itself throws for a failed connection — a `DOMException`
  named `NetworkError`, not a `TypeError`. **A fork whose tests rely on a
  real HTTP call will now fail fast** with a message naming the URL; stub it
  with `vi.stubGlobal('fetch', …)` or mock the module that issues it. Note this
  has to hook happy-dom's own fetch layer — it ships its own implementation
  over `node:http` and binds it before `tests/setup.ts` runs, so patching
  `globalThis.fetch` intercepts none of it. Two exemptions: an **aborted**
  request still rejects with `AbortError` (happy-dom runs the interceptor before
  its own signal check, so refusing unconditionally would silently break every
  `if (err.name === 'AbortError')` branch), and `data:`/`blob:` URIs pass
  through, since they open no socket.

- **Vitest worker count is capped off CI** — at
  `min(4, floor(cores / 2))`, so 4 on a 10-core machine, 3 on a 6-core, 2 on a
  4-core, 1 on a 2-core. Sized against vitest's **watch** default
  (`floor(cores / 2)`) rather than its `run` default (`cores - 1`), because every
  local script here is watch mode and `resolveMaxWorkers` returns an explicit
  `maxWorkers` before it reaches the watch branch — a flat 4 would therefore
  *raise* the count on any machine smaller than this one. The default assumes a
  machine running one suite; agents run this one in the background behind
  `validate` and `/pre-pr`, often several at once against different forks. Measured on a 10-core machine, the cap costs ~6% wall-clock
  (239s → 254s) while halving the aggregate work (summed in-worker test time
  860s → 326s) — the default was buying contention, not parallelism. CI is
  untouched: a shard has its runner to itself and runner size varies by fork.

## [0.9.0] — 2026-08-17

> **Alpha release.** Twelfth tagged Sunrise release. **MINOR bump** — the
> largest batch Sunrise has cut: a security sweep, a dependency-hygiene
> programme, and the production Docker path made to actually work.
>
> **No migration.** Zero migrations and no `prisma/schema/` change since 0.8.1,
> so a fork takes this with a plain `git merge v0.9.0` and no database step.
>
> **Security — read this section even if you skip the rest.** An SSRF sweep
> closed four related holes: `checkSafeProviderUrl()` validated only the first
> hop, so a redirect to `169.254.169.254` reached cloud metadata and had the
> body ingested as a knowledge document; `http://[::ffff:169.254.169.254]/`
> matched nothing in the denylist, so every range check returned false;
> escalation webhooks were never validated at all; and the webhook subscription
> dispatcher followed redirects. An open redirect in `isRootRelativePath()` was
> reachable from the login form's `callbackUrl` — the victim authenticates on
> the genuine page and lands on the attacker's origin. Storage HMAC schemes are
> now domain-separated, and the local storage provider refuses a key escaping
> its own root.
>
> **Node 24 is now the floor.** Node 20 reached end-of-life; `.nvmrc`,
> `engines.node`, both Dockerfiles and `@types/node` are checked against each
> other by `npm run check:node-version`, which reads the **resolved**
> `@types/node` from the lockfile rather than the range. `@types/node` moved
> `^26` → `^24`: a deliberate direct downgrade, because type-checking against a
> standard library two majors ahead of every runtime accepts APIs that throw in
> production.
>
> **Deployment is fork-facing and worth reading before you merge.**
> `.env.production` is no longer baked into the production image, the Prisma CLI
> is no longer in the runtime image, the `deps` stage no longer takes a
> `DATABASE_URL` build argument, and there are now `migrator` and `seeder`
> stages. If your fork's deploy runs migrations from inside the running web
> container, or passes `DATABASE_URL` at build time, it needs a change. The CI
> `docker` job now runs the production stack rather than only building it —
> which is how it was found that the stack could not start at all.
>
> **Other breaking-in-`0.x` changes.** `PATCH …/capabilities/{id}` returns 403
> for a change to a system capability's `slug`, `functionDefinition`,
> `executionType` or `executionHandler` — automation reconfiguring a built-in
> over the API must move into its seed unit. A structured extraction cut off at
> the token cap now raises `truncated_no_output` instead of returning partial
> JSON. Error-marker assistant messages are no longer replayed into the prompt.
> The EPUB parser swapped `epub2` for `epub`, which removes `adm-zip` and its
> permanently-unfixable high advisory from the tree entirely — a fork importing
> `epub2` directly must switch.
>
> **Two silent-data-loss bugs.** Every `.epub` ever ingested produced an empty
> document — filename as title, zero sections, no warning — because
> `await epub.parse()` awaited a non-Promise. And built-in capability seeds
> stopped re-applying their function schema, so three shipped capabilities were
> advertising a stale schema to the model.
>
> **Dependency hygiene got machinery rather than care.** `check:lockfile`,
> `check:exports`, `check:changelog`, `fix:lockfile-libc` and a scheduled
> `Dependency Audit` all landed, after `libc` metadata went missing for two
> releases and put glibc binaries in a musl image without erroring.

### Security

- **`js-yaml` bumped to 4.3.1**, clearing a high advisory
  ([GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj),
  CVE-2026-59870 — quadratic CPU consumption resolving `!!omap`). Transitive and
  **dev-only**, via `@eslint/eslintrc`, so no fork runtime parses attacker-supplied
  YAML through it; taken because the fix is a patch and a release should not ship
  with its own audit red. Found by triggering `Dependency Audit` as step 5 of
  this cut — the first time that workflow has ever completed.

- **Open redirect closed in `isRootRelativePath()`.** The WHATWG URL parser
  removes ASCII tab, LF and CR from anywhere in a URL before reading the
  authority, so `/<TAB>/evil.com` survived `trim()` and the `path[1]` check and
  then collapsed to `//evil.com`. The reachable sink was
  `components/forms/login-form.tsx`, which reads `callbackUrl` off the query
  string and `router.push()`es it after a successful login — a phishing
  primitive, since the victim authenticates on the genuine page and lands on
  the attacker's origin. The OAuth path was never affected (better-auth's
  `matchesOriginPattern` rejects the character). Same class as #437, which
  fixed it in `sanitizeUrl()`; the reasoning never propagated to the other
  guard in the same file (#506).
- **`safeCallbackUrl()` now returns the normalized string** rather than the raw
  input, so the value that was judged safe is the value the caller navigates
  to. `resolveAuthLandingRoute()` in `lib/auth-landing/route.ts` was corrected
  the same way (#506).
- **Redirects are no longer an unvalidated second SSRF target.**
  `checkSafeProviderUrl()` validates one URL, so a caller that followed
  redirects presented it with only the first hop.
  `POST …/knowledge/documents/fetch-url` now re-runs the guard on **every**
  redirect target (`redirect: 'manual'`, capped at 5 hops, relative `Location`
  resolved against the redirecting URL) — previously
  `https://attacker.example/doc` → `302` → `http://169.254.169.254/…` reached
  cloud metadata and had the response body ingested as a knowledge document.
  The event-hook dispatcher takes the opposite and stricter route,
  `redirect: 'error'`: its URL is validated at create/update time and never at
  dispatch, and following a redirect would POST the event payload *and its HMAC
  signature headers* to the new target. Both paths are `withAdminAuth`, so this
  is hardening rather than a privilege boundary (#534).
- **SSRF guard: IPv4-in-IPv6 literals are no longer a bypass.**
  `http://[::ffff:169.254.169.254]/` reaches the same host as
  `http://169.254.169.254/` — verified against a live listener — but the mapped
  form matched nothing in the denylist and made `parseIpv4()` return `null`, so
  every range check was false and `checkSafeProviderUrl()` returned `ok`. Cloud
  metadata, loopback and RFC1918 were all reachable through a guard reporting
  success. Mapped (`::ffff:`) and the deprecated IPv4-compatible (`::`) forms
  are now unwrapped to their dotted quad **before** any comparison, so they obey
  exactly the same policy as the plain form — including `allowLoopback`, which
  still works for a local provider addressed that way. Found by `/code-review`
  on the redirect work below, which had claimed to close the metadata attack
  while this made it reachable in one line (#534).
- **`safe-url.ts`'s header no longer claims a compensating control it does not
  have.** It cited the re-check in `provider-manager.buildProviderFromConfig`
  as covering DNS rebinding; that call re-parses the same string and resolves
  nothing, so against a hostname pointing at a private address it adds nothing.
  The absent DNS resolution is now stated as an accepted risk, and the
  per-URL-not-per-hop limitation is documented alongside it (#534).
- **The webhook subscription dispatcher refuses redirects too.**
  `attemptWebhookDelivery` in `lib/orchestration/webhooks/dispatcher.ts` had the
  same defect fixed in the event-hook dispatcher above: `sub.url` is validated
  by `isSafeProviderUrl` in the Zod refine at create/update and never again at
  dispatch, while `fetch` defaulted to following redirects — so a redirect
  POSTed the payload *and its `X-Webhook-Signature` header* to an unvalidated
  second target. Now `redirect: 'error'`. **Behaviour change on upgrade:** a
  subscription pointing at an endpoint that responds with a redirect (an
  `http`→`https` upgrade, or a trailing-slash redirect) will start failing
  delivery until its URL is re-pointed; the failure is non-terminal and retries
  as normal. Both dispatchers now also record the underlying `cause` of a fetch
  failure rather than a bare `fetch failed`, so that case is diagnosable from
  the delivery log (#534).
- **Escalation webhooks are validated against SSRF at last.**
  `escalationConfig.webhookUrl` was `z.string().url()` with **no**
  `isSafeProviderUrl` refine, while every comparable outbound target has one —
  provider `baseUrl` and the webhook subscription `url` alongside it in
  `lib/validations/orchestration.ts`, and event-hook `action.url` in
  `lib/orchestration/hooks/types.ts`. An escalation therefore POSTed its payload — conversation
  reason, priority and metadata — to whatever host was configured, cloud
  metadata and RFC1918 included. Guarded now in the two places that matter,
  mirroring how provider `baseUrl` is handled: `escalationConfigWriteSchema`
  rejects an unsafe target at the API boundary, and `notifyEscalation` re-checks
  at dispatch so a direct DB write, a restored backup bundle or a value stored
  before this release is still refused. The POST also refuses redirects (#553).
- **A rejected escalation webhook is preserved, not destroyed.** The guard is
  deliberately *not* on the read path. Rejecting there would make the stored
  value invisible to the settings API — and because the settings form rebuilds
  the whole config blob on save, the next save of any unrelated field would have
  written it back as absent, silently deleting a URL nobody chose to remove.
  Instead the value is read, shown in the form, and skipped at dispatch with a
  warning naming the target, so an operator can see the problem and correct it
  (#553).
- **Escalation webhooks refuse redirects — note this failure is quieter than the
  dispatchers'.** Same reasoning as the two webhook dispatchers above, but
  `notifyEscalation` is fire-and-forget: there is no retry and no delivery row,
  so an escalation endpoint that starts redirecting (an `http`→`https` upgrade,
  say) fails **once per escalation** with a single `logger.warn` as the entire
  signal. That warning now names the underlying cause rather than reporting a
  bare `fetch failed` — without it the condition is effectively undiagnosable.
  If you route escalations through a redirecting endpoint, re-point it (#553).
- **The two HMAC token schemes are domain-separated.** `lib/storage/access-tokens.ts`
  (grants a read of one storage key) and `lib/orchestration/approval-tokens.ts`
  (grants an approve/reject on one execution) sign the same
  `base64url(payload).base64url(HMAC-SHA256(BETTER_AUTH_SECRET, payload))`
  construction with nothing in the signed bytes saying which scheme a token
  belongs to, so a signature minted by one verified structurally as the other.
  Cross-scheme replay failed only at the next step, because the two payload
  schemas happen to be disjoint on required fields (`key` vs `executionId`) —
  a property of today's shapes, not a decision, and one that stops holding the
  day either payload gains an optional field that satisfies the other's schema.
  Both payloads now carry a `typ` tag (`storage-read` / `workflow-approval`)
  that verification asserts. A third scheme on the same secret must declare its
  own (#507).
  **Breaking for outstanding tokens:** the tag is inside the signed bytes, so
  every token minted before this release fails verification. In practice that
  is unclicked approval links (default 7-day expiry) and signed storage URLs
  (capped at 7 days) — the same blast radius as rotating `BETTER_AUTH_SECRET`.
  A dead approval link is not a stuck execution: the admin approval queue acts
  on the execution directly under a session and never touches these tokens.
  A dead storage URL is re-minted by whatever issued it. The third surface is
  an in-chat or embedded approval card held by a browser across the deploy —
  `run_workflow` hands the tokens to the client and they are persisted on
  `AiMessage.metadata.pendingApproval` — which reports "Invalid or expired
  approval token" on click, and on the embed surface the end user has no admin
  queue to fall back to. Narrow, because a history reload drops
  `pendingApproval`: it affects only sessions already open when you deploy.
- **The local storage provider refuses a key that resolves to its own root.**
  `validateStorageKey('.')` passes every rule it has (no `..`, not absolute, no
  NUL, no backslash) and `resolve(root, '.')` is `root`, which `resolveWithin()`
  used to permit — so a prefix of `.`, `./` or any equivalent reached
  `rm(root, { recursive: true })` in `deletePrefix()` and erased every object
  the provider held. The same key in `upload()` is not the harmless `EISDIR` it
  looks like either: with the root absent (the default `.storage/private` on a
  fresh checkout) it `mkdir`s **outside** the root and writes a regular file at
  the root path, after which every upload fails `ENOTDIR`. The rejection
  therefore lives in `resolveWithin()` and covers all four operations, rather
  than only the destructive one. Not reachable today — object keys are
  `avatars/${userId}/…` and `${keyPrefix}${randomUUID()}${ext}`, and no route
  accepts a caller-supplied prefix — so this is defence in depth, taken because
  the `deletePrefix` blast radius is total and the check is one comparison. S3
  and Vercel Blob are unaffected: a prefix there is a literal string match
  against keys, not a path (#508).
- **A capability's advertised tool name is now its slug, closing a gap in the
  #476 tool-call guard.** The guard built its advertised set from each
  capability's `functionDefinition.name`, while dispatch resolved the name a
  model emitted *as the slug*, and no schema required the two to agree — so a
  capability was checked under one identity and executed under another. A row
  with `slug: 'estimate_workflow_cost'` and
  `functionDefinition.name: 'apply_audit_changes'`, bound to a low-privilege
  agent, passed the guard and ran the privileged built-in. Admin write access
  was needed to author it, so no trust boundary was crossed; it is fixed because
  the guard reads as authoritative over the thing that dispatches, and because a
  future import path or self-service capability builder would turn it into a
  real escalation. `getCapabilityDefinitions()` now advertises the slug, which
  also corrects the `capabilitySlug` recorded on tool messages and evaluation
  logs — previously a name written into a slug field (#509).
- **`functionDefinition.name` must equal `slug` on create and update.** The
  runtime override above is the backstop for rows already stored; this stops the
  divergence being authored. Divergence was never useful even before it was a
  security question: the tool was advertised under a name dispatch could not
  resolve, so it failed — unless the name happened to match another capability's
  slug, which is the escalation. The check is on the write path only; the read
  path repairs instead of rejecting, so an existing divergent row keeps working
  rather than vanishing from its agent's toolset (#509).
- **A capability's `functionDefinition` must be written whole.** `description`
  and `parameters` were optional on create and update while the read validator
  requires both, and a write replaces the whole JSON column — so
  `{ "name": … }` alone silently discarded the rest and left a row the runtime
  cannot parse. That was also a two-step walk around the rule above: PATCH a
  definition that *agrees* with the slug but is stripped, then PATCH the slug
  alone, and with nothing left to compare against the check was skipped. Both
  schemas now require the full shape (#509).
- **`agent_call` refuses a tool the agent was never advertised.** The #476
  tool-call guard was added to the chat handler only; the workflow `agent_call`
  executor dispatched whatever name the model emitted, and because a missing
  `AiAgentCapability` row synthesizes a default-ALLOW binding, that capability
  then ran unrestricted. The reachable route is injected content rather than an
  admin — a knowledge document, a tool result, or an upstream step's output
  naming any globally-registered slug. The executor now builds
  `advertisedToolNames` from `getCapabilityDefinitions` and feeds a
  `tool_not_advertised` result back to the model, keeping the assistant+tool
  message pair intact so the next provider call stays well-formed. Swept the
  other dispatch callers: three of the four take a name from a model. Chat is
  guarded (#476); MCP is too — the host behind an MCP key is an LLM — and it
  checks the globally exposed tool set, which is the grant, though **not** the
  calling key's scoped agent, that being deliberate opt-out scoping documented
  in `.context/orchestration/mcp.md`. Only `tool_call` is not model-driven at
  all: its slug comes from Zod-parsed, admin-authored step config. The
  dispatcher note claiming the chat guard "closes the reachable path" is
  corrected: it was true of one of the two model-driven surfaces. The refusal
  also emits `capability.refused_not_advertised`, the hook the chat handler
  already fires and the docs describe as a security signal — a subscriber
  keying on `conversationId` would otherwise have seen chat refusals and been
  blind to workflow ones. The workflow payload carries `executionId` + `stepId`
  in its place (#559).
### Added

- **`jsonEquals()` on `@/lib/utils/json-equal`** — structural equality for JSON
  values that ignores object key order. Needed wherever one side of a comparison
  has been through Postgres (`jsonb` canonicalises key order on write) or Zod
  (which rebuilds a parsed object in schema-declaration order), so the same
  value round-trips to two different strings and a `JSON.stringify` comparison
  calls it changed. The two existing `valuesEqual` helpers
  (`agent-version-diff.ts`, `apply-audit-changes.ts`) are deliberately *not*
  key-order-insensitive — both compare values produced by the same code path on
  both sides. Values that are not JSON — `Date`, `Map`, `Set`, `RegExp`, class
  instances — are reported **unequal** rather than compared by their (empty) own
  key sets, which would otherwise make any two `Date`s equal (#598).
- **`SEED_OWNED_CAPABILITY_FIELDS`, `changedSeedOwnedFields()` and the types
  `SeedOwnedCapabilityField` / `SeedOwnedCapabilityValues` on
  `@/lib/orchestration/capabilities`** — the single definition of which
  `AiCapability` fields belong to the seeds rather than the operator, and the
  value-level (not presence-level) diff both write paths consult. A fork adding
  a third write path to capabilities should call it rather than re-deriving the
  list (#598).
- **`Fork Sync Integrity` workflow — catches a squash-merged sync PR.** Squashing
  a sync PR keeps every file but discards the second parent, so git no longer
  knows the release tag is in your history and the merge base against upstream
  silently reverts to the **previous** release. Nothing looks wrong until the
  next sync replays the whole preceding range and re-conflicts every file
  already resolved by hand. `scripts/ci/check-sunrise-ancestry.sh` asserts that
  the release the tree claims in `lib/sunrise-version.ts` is genuinely an
  ancestor of `HEAD`, and runs on every push to `main`, so the repair is still a
  zero-diff `git merge -s ours` while the context is fresh — the failure
  annotation carries that command, `%0A`-encoded onto one line so it survives
  GitHub's line-scoped workflow commands rather than being left in log output. **A guaranteed no-op in Sunrise's own repository**
  (Sunrise tags every release on `main`), and self-enforcing downstream: a fork
  receives the workflow *by doing a sync merge*, so squashing that sync makes it
  fire on the first run afterwards. It has exactly one failing path: everything
  else skips, including a version bumped before its tag is pushed (every Sunrise
  release, at the moment of cutting it), an unreachable upstream, a shallow
  clone, a fetched tag belonging to some other project's release of the same
  name, and any `git merge-base` error that is not a plain "not an ancestor".
  Each skip emits a `::warning::` annotation, because a guard that goes
  permanently and silently green is the original failure mode one level up. **Fork-facing:** set `SUNRISE_UPSTREAM_URL` if your
  upstream is not Sunrise itself (a leaf fork of a framework-tier fork) — as a
  repository **variable**, or as a **secret** of the same name if the URL has to
  carry a token for a private upstream (the workflow prefers the secret; secrets
  are masked in logs and write-only, variables are neither).
  `CUSTOMIZATION.md` §9 now opens with the merge-don't-squash rule and the
  repair (#539).
- **`finishReason` on the `done` SSE event.** `ChatEvent.done` now carries an
  optional `finishReason` (`'stop' | 'tool_use' | 'length' | 'error'`) telling a
  consumer why the provider stopped generating on the final turn of the tool
  loop. `'length'` means the assistant text is a **fragment** cut off at the
  token cap, not a complete answer. The information already existed on
  `StreamChunk.done`; the chat handler discarded it, so nothing downstream of
  the stream could distinguish "the model produced the wrong shape" from "the
  model was interrupted mid-shape". `drainStreamChat` surfaces it on
  `DrainResult` too. **Optional and additive** — absent when the provider
  reports nothing, and no existing consumer (widget, admin chat UI, forks) has
  to read it (#594).
- **`ProviderError.usage`** — tokens the provider billed for the call an error
  ended, populated by the four truncation guards. A truncation is a full cap's
  worth of output, the most expensive shape a turn has, and it used to vanish
  with the response when the guard threw: the vendor charged and `AiCostLog`
  recorded nothing. `streamChat` now costs it on that path, and
  `runStructuredCompletion` folds it into the totals it returns. Absent for
  errors raised before the model produced anything (#587).

- **`isRequestFault()`** on `@/lib/orchestration/llm/provider` — is this
  `ProviderError` a fault in the request rather than the provider, i.e. one
  that re-running, re-routing or failing over cannot fix? Used by `streamChat`
  to skip provider failover and by the engine's executors to mark the step
  non-retriable. Currently `truncated_no_output` only (#587).

- **`StructuredCompletionResult.finishReason`** — the finish reason of the
  attempt that produced the value. Worth checking for `'length'` even on
  success: a lenient `parse` can accept content that happened to be well-formed
  where it was cut off, and a truncated array of results reads as a complete
  short one. The failure path throws, so this field is the only place that case
  is visible (#587).

- **`migrator` and `seeder` Dockerfile stages**, and a profile-gated `seeder`
  compose service. Both derive from `deps`, so they duplicate no layers and cost
  a normal `docker build` nothing — BuildKit only materialises the stages the
  requested target needs. They sit **before** `runner` in the file on purpose:
  the last stage is what a bare `docker build .` produces, and that must stay
  the runtime image (#583).

- **`ESCALATION_WEBHOOK_ALLOW_PRIVATE`** — opt a deployment into escalation
  webhooks targeting its own private network (an in-VPC relay), for the case
  where the alternative is no validation at all. Off by default; accepts exactly
  `"true"` or `"false"` so a typo fails startup rather than silently leaving it
  off. Backed by a new `allowPrivateNetwork` option on `checkSafeProviderUrl` /
  `isSafeProviderUrl`.
  **It relaxes RFC1918, IPv6 unique-local and loopback** — the last so a
  same-pod relay sidecar on `127.0.0.1` works, matching what `isLocal` already
  allows for LLM providers. It does **not** relax link-local
  (`169.254.0.0/16`, `fe80::/10`) or CGNAT (`100.64.0.0/10`), and the reason is
  the same for both: a denylist of metadata *literals* is not enough.
  `169.254.169.254` is only the best-known one — AWS ECS task metadata vends IAM
  role credentials from `169.254.170.2`, EKS Pod Identity from
  `169.254.170.23` — and `100.64/10` is shared address space (the default
  Tailscale range) containing Alibaba Cloud metadata at `100.100.100.200`.
  Cloud-metadata hostnames, the unspecified address and the scheme allowlist are
  untouched (#553).
- **`describeFetchFailure(err)`** in `lib/errors/fetch-error.ts` — renders a
  thrown value for an operator, unwrapping undici's `cause`. Node's `fetch`
  reports nearly every network-layer failure as a bare
  `TypeError: fetch failed` and puts the real reason on `error.cause`, so a
  refused redirect, a DNS miss and a connection reset are indistinguishable
  from the message alone. Extracted once three outbound callers needed it
  (`hooks/registry.ts`, `webhooks/dispatcher.ts`, `escalation-notifier.ts`),
  all of which gained `redirect: 'error'` and have to explain that refusal to a
  human. Only `Error` and `string` causes are unwrapped — an arbitrary object
  would reach the log as `[object Object]` (#553).

- **`normalizeRootRelativePath(path)`** in `lib/security/sanitize.ts`, exported
  via `@/lib/security` — returns the parser-normalized path when it is genuinely
  same-origin, or `null`. Prefer it over `isRootRelativePath()` wherever the
  value gets navigated to: returning the normalized form is what stops a caller
  validating one string and using another. `isRootRelativePath()` is unchanged
  in signature and now delegates to it (#506).
- **`npm run check:changelog`** — a structure check on `CHANGELOG.md`, wired
  into `npm run validate` (first, so it fails in milliseconds rather than
  behind the type-check) and into the CI `lint & format` job, which is ungated
  and so runs on docs-only PRs too. Nothing checked this file before: Prettier
  saw well-formed markdown, `/security-review` correctly skips markdown, and
  `/pre-pr` step 5d only checks the CHANGELOG is *present* in a public-surface
  diff. It enforces unique version headings in descending SemVer order, real
  dates, `## [Unreleased]` present, first and undated, Keep-a-Changelog `### `
  categories that do not repeat within a section, agreement between the topmost
  release and `SUNRISE_VERSION` — and, comparing against the base revision,
  that a released heading is never deleted. That last rule is the one that
  catches the incident behind it: cutting 0.8.1 replaced a block that included
  `## [0.8.0]`, never re-added the heading, and 962 lines of 0.8.0 content —
  two migrations, two breaking changes — re-attributed themselves to a patch
  release, merged, and were tagged. **Forks:** the check assumes
  `CHANGELOG.md` carries Sunrise's release history, which it does by default
  after any upstream merge; keep your own app's release notes in a separate
  file. See `.context/architecture/ci.md` (#550).
- **`npm run format:prisma` and `npm run format:prisma:check`**, the latter
  wired into `npm run validate` and now the implementation the CI step calls
  too. Prettier has no `.prisma` parser, so schema drift from the pinned
  Prisma's own formatter was invisible to `format:check` and surfaced only as a
  red CI job named "Lint & format" — a misleading place to look for a Prisma
  problem, on a branch about something else. It lands hardest on forks: the
  `/framework` and `/app` tiers own `framework-*.prisma` and `app.prisma`,
  exactly the files core never reformats, so a Prisma bump upstream silently
  invalidates formatting only the fork can fix. The check formats a **copy** in
  a temp directory and compares, rather than running the formatter over
  `prisma/schema` and diffing against git: the git form is correct only on a
  clean tree, and locally it reports your own well-formatted uncommitted work
  as drift — the exact situation a local check exists for. It walks
  `prisma/schema` **recursively**, because `prisma format` does, and a flat
  listing would silently skip a fork's nested schema files while failing P1012
  on any relation that crossed into them. It runs Prisma's own declared entry
  point under `process.execPath` rather than `npx` or the `.bin` shim: both
  force a shell on Windows, and `shell: true` concatenates argv without
  escaping it (Node emits DEP0190 saying so), which would split any temp path
  containing a space — `os.tmpdir()` there sits under `%USERPROFILE%`. Formatter errors are
  rewritten to name the real schema path: Prisma reports against the copy, and
  the copy is deleted before the message prints. `format:prisma` is the
  mutating fixer, mirroring `format` / `format:check` (#510).
- **Scheduled `Dependency Audit` workflow** (Mondays, plus `workflow_dispatch`)
  asking whether the tree is clean **as it stands** — the question
  `dependency-review` cannot answer, because it diffs a PR and so goes green
  forever once a vulnerable version is on `main`. Dependabot does watch the
  tree and does work here, but has no package to bump when the fix lives in a
  **grandparent**: `ws@8.20.1` sat behind `engine.io` and `socket.io-adapter`,
  both declaring `ws: ~8.20.1` and neither vulnerable, so no PR was raised and
  the alert stayed open seven weeks (#538). `adm-zip` was in that state when
  this landed, and is the case that proved the point: no bump existed at all,
  because `epub2` pinned it below the patched version — it took replacing the
  library to clear it (#601, under **Changed**).
  Two independent jobs: `npm run check:audit`, and the absolute counterpart to
  `check:lockfile` via `fix:lockfile-libc --check`, which catches `libc`
  missing since before the base commit — the state `main` was in for two
  releases (#571) and which no diff check can see. **Forks inherit both**, and
  neither needs Advanced Security, so unlike CodeQL and dependency-review they
  run on private forks too. `check:audit` fails only on findings actionable
  today (at or above the floor with a non-major fix) and reports the rest to
  the job summary: measured against this repo, two of eight high advisories had
  no fix at all, so a plain `npm audit --audit-level=high` would have failed
  every week from day one for something nobody could clear. Gating on
  fixability is self-clearing for the no-fix case — the day `epub2` accepts a
  patched `adm-zip`, the job goes red on its own, with no allowlist to curate.
  A fix that exists but cannot be taken is not covered; the remedy there is
  usually a `package.json` `overrides` entry, which `check:lockfile` gates as a
  reviewed decision. `--floor=` raises
  the bar; `--report` downgrades findings to advisory, though the job still
  fails if the audit could not be run at all (#549).
- **`npm run fix:lockfile-libc`** restores `libc` to `package-lock.json` from
  the registry, with `--check` to report without writing. Needed because npm
  below 11.11.0 deletes the field on every write and no npm puts it back — once
  it is gone the tree reads as up to date, so nothing recomputes the metadata.
  It reads each package's registry manifest at its exact locked version
  (`/<name>/<version>`, ~2 KB — not the whole packument, which for `vite` is
  37 MB of publish history), so a version cannot move by construction, and it
  inserts the key where npm's serialiser would put it — alphabetically among
  the scalar keys, which is after `dev` and before any object-valued key,
  `dependencies` included. Package names and versions are validated against
  npm's grammar before becoming URL path segments, and every request is bounded
  by a timeout and retried with exponential backoff. It refuses to write when
  the lockfile does not survive a JSON round-trip, when the registry is
  unreachable, or when an existing value disagrees. Validated by
  strip-and-restore against
  `d5b913fb^`, the last lockfile a modern npm wrote: delete all 77 `libc`
  fields, rebuild from the registry, and the file comes back byte-identical.
  Deliberately not in `validate` or CI — it needs the network, and the
  automated guard is `check:lockfile` (#571).
- **`npm run check:lockfile` and `npm run check:exports`**, both wired into
  `/pre-pr`, which was silent on two classes of change it should never have
  been. A PR whose entire substance is `package-lock.json` got a clean bill
  from a gate that builds its file set from `*.ts` — which is what happened
  during the 0.8.1 cut, where `npm update` stripped `libc` from five native
  Linux packages. That one was caught by hand before it was committed, so
  0.8.1 shipped clean; an earlier dependabot merge was not, and **v0.8.0
  shipped with 72 packages already missing `libc`**. Every fork inherited it by
  taking 0.8.0 — nothing to do with the 0.8.1 upgrade. Repaired in the same
  release; see the Fixed entry for #571. `check:lockfile` compares the parsed
  trees and fails on the things
  that need a decision: platform metadata (`libc`/`os`/`cpu`) lost, a **direct**
  dependency moved backwards, or `overrides` changed. Transitive downgrades are
  listed but do not gate — measured over all 134 lockfile commits in this
  repo's history, there are 45 of them against 2 direct, and they cluster in
  commits like "pin Prisma to ~7.1.0" where one intended pin drags its subtree
  back. Running it over that history flags 5 commits, every one a real event.
  `check:exports` answers step 5d's question — *did the set of importable
  symbols change?* — from the surface rather than a hardcoded path list, by
  diffing what every `lib/**/index.ts` barrel exports. It uses the TypeScript
  compiler rather than a regex because six of those exports are `export *`
  (three of them `export * as ns`), which a regex cannot follow; specifiers
  resolve through the `@/` alias, since CLAUDE.md mandates it and ESLint
  forbids relative paths, so `@/` is the only form this codebase produces. A
  star it cannot follow is reported, on both revisions, rather than counted as
  zero symbols — "nothing exported" and "could not look" are not the same
  answer. It reports and never gates. Over the last 60 commits it fires once:
  on #506's `normalizeRootRelativePath`, the export the path list missed
  (#552).

### Changed

- **The EPUB parser now uses `epub` instead of `epub2`.** `epub2` is a fork of
  `epub` that overtook it while the original was dormant; the original has since
  been modernised and the fork has not published since September 2023. Three
  open issues were all downstream of that one choice, and all three close here:

  - **#601** — `epub2` pins `adm-zip ^0.5.10` while the fix for its high
    advisory is `0.6.0`, so no Dependabot PR could ever arrive and no in-range
    bump existed. `epub` depends on `fast-xml-parser` + `jszip` instead, so
    `adm-zip` leaves the tree entirely — `npm audit` on the new tree reports
    **0 vulnerabilities**. No `overrides` entry was needed, which also means
    this never touched the `overrides` gate.
  - **#614** — a malformed OPF made `epub2` reject *and then* throw an
    uncatchable `TypeError` out of its own inflate callback, an
    `uncaughtException` reachable from an admin upload. `epub` rejects cleanly;
    verified against the same crafted archive.
  - **#606** — `parse()` and `getChapterRaw()` genuinely return promises here,
    so the class of bug is gone rather than worked around.

  Also removed: the temp-file dance (`epub` reads a `Buffer` directly, where
  `epub2` could only read a path), and `types/epub2.d.ts` — the hand-written
  declaration that shadowed the library's own and, by claiming both methods
  returned promises, silenced the `await-thenable` rule that would have caught
  #606 at authoring time. `epub` ships its own types, so there is nothing left
  to get wrong there. Nothing chose `epub2` deliberately: it arrived inside a
  large feature commit in April 2026 with no comparison recorded anywhere.

  **Fork-facing:** if you import `epub2` directly, it is no longer a dependency.
  `parseEpub()`'s own signature and return shape are unchanged.

  **Verified beyond the unit suite**, because this path has twice broken in ways
  vitest could not see and `epub` is ESM-only: a production build, then a real
  `.epub` uploaded through the real admin route against both `next start` and
  the **standalone** server, asserting the book's prose landed in the stored
  chunks. That check is now `npm run smoke:epub`.

- **`check:lockfile` no longer fails a PR for a direct-dependency downgrade.** It
  reports them in their own block instead. The rule existed because "a version
  going backwards is how a patched dependency quietly returns to a vulnerable
  one" — but that is a proxy for a risk something else measures exactly:
  `dependency-review` runs on every PR at `fail-on-severity: high` and fails a
  change landing on a **known-vulnerable** version, and `check:audit` covers the
  standing tree weekly. Measured over all 134 commits that touched this
  lockfile, the rule would have fired twice, on `pin Prisma to ~7.1.0` and `pin
  jsdom to 26` — two deliberate pins, zero accidents. A gate whose only outcomes
  are false positives teaches people to route around it. **Fork-facing:**
  `dependency-review` is skipped on private repos, so a private fork now has no
  per-PR enforcement here — the downgrade is still printed prominently, with
  that caveat in the output. Lost `libc`/`os`/`cpu` and `overrides` changes still
  gate: both are rare, neither is covered by another PR-time check, and the
  first is the one that actually shipped broken (#571) (#584).
- **`@types/node` pinned to the runtime major (`^26` → `^24`), and added as a
  fifth source to `npm run check:node-version`.** #581 established Node 24 as
  the floor and `node:24-alpine` as what ships, but `tsc` was type-checking
  against a standard library **two majors ahead of every runtime we run on** —
  so it accepted any API added in Node 25 or 26 and reported nothing, with the
  first signal a `TypeError` in the production image on a path the types called
  safe. Pinning to `^24` produced a clean `tsc --noEmit`, so nothing in the tree
  depended on the post-24 surface. The version-consistency check now covers all
  five declarations across four files instead of four, and a Dependabot `ignore`
  holds `@types/node` at `>=25` so the major cannot re-land silently — which is
  how it arrived. **Fork-facing:** a fork on a different Node major must move
  `@types/node` with `.nvmrc`, both Dockerfiles and `engines.node`, or
  `check:node-version` fails; a fork that had been relying on the newer types
  will see real errors, and those are the point. Only the major is compared, so
  `24.x` minors still flow through Dependabot. The fifth source reads the
  **resolved** version from `package-lock.json` rather than the range in
  `package.json`, because a range need not pin a major — `>=24` resolves to
  26.2.0, so a range-based check reported "consistent" for exactly the drift
  it was added to catch (#584).
- **`PATCH …/capabilities/{id}` now returns 403 for a change to a system
  capability's `slug`, `functionDefinition`, `executionType` or
  `executionHandler`.** **Fork-facing:** any automation that reconfigures a
  built-in capability over the API will start failing at that call. It was
  already failing — silently, at the next re-seed — so the fix is to move the
  change into the capability's seed unit in `prisma/seeds/`, which is where it
  had to live to survive a deploy. Every other field, including
  `executionConfig`, stays editable. See the entry under **Fixed** for the full
  reasoning (#598).
- **A structured extraction cut off at the token cap is now an error on the
  OpenAI-compatible adapter, not partial JSON.** It already was on Anthropic
  and on the empty-content case; what changes is `finish_reason: 'length'` with
  **non-empty** content when `responseFormat` is a `json_schema` and the turn
  has no tools — on both the streaming and non-streaming paths. Such a call
  previously returned (or streamed) a fragment of an object; it now raises
  `ProviderError('truncated_no_output')`. **Fork-facing:** any caller that was
  salvaging partial JSON from a truncated extraction will now see a thrown
  error instead — raise `maxTokens`. A turn that carries tools is unaffected:
  a `length` stop there is the ordinary partial-output case.
  `runStructuredCompletion` keeps its retry on a truncation and now absorbs the
  adapter's throw to get there — the stricter temp-0 retry prompt is a real
  remedy for the commonest truncation of all, a model spending the budget on a
  preamble before starting the JSON. Once both attempts are spent it does
  **not** consult the caller's `onFinalFailure` hook, which exists to phrase
  "the model broke my contract" — a premise that is false here (#587).

- **A chat stream no longer fails over to another provider when the fault is in
  the request.** A `truncated_no_output` `ProviderError` now ends the turn
  instead of retrying against each configured fallback and recording a
  circuit-breaker failure for every one. The token cap comes from the agent's
  config, so a fallback rejects it identically; the old path billed a full-cap
  call per provider, wiped the visitor's screen with a `content_reset` each
  time, and could open a healthy provider's breaker for every other agent using
  it. Deliberately a one-entry code list and **not** the `retriable` flag:
  `toProviderError` marks every 4xx non-retriable, and failing over on a `401`
  from a provider with a stale key is exactly what fallbacks are for. That path
  also now persists an error-marker assistant message, so a failed turn no
  longer reloads as a user question with no answer (#587).

- **Error-marker assistant messages are no longer replayed into the prompt.**
  `loadHistory` returned them like any other turn, so
  `[An error occurred and the response could not be completed.]` became a
  permanent part of the model's context — burning tokens and inviting
  imitation — for the rest of the conversation. They are persisted for the
  *client*, so a failed turn renders instead of an unanswered question, and are
  now filtered out of prompt rebuilding. Pre-existing, but newly common: this
  release persists a marker for every `ProviderError` reaching the outer catch,
  where previously an exhausted 429/503 left no row at all (#587).

- **A workflow step's failed LLM attempt now reports what it cost.** `llm_call`,
  `chat_turn` and `agent_call` wrapped a `provider.chat()` throw with
  `tokensUsed`/`costUsd` left at 0 — the very fields the engine's retry
  accumulator folds into the step trace and the execution total. A truncation
  is a full cap's worth of billed output, so the priciest attempt a step made
  was the one missing from its totals. They now carry `ProviderError.usage`
  when the provider reported it (#587).

- **A request-fault provider failure is no longer retried by workflow steps.**
  `ExecutorError` defaults to `retriable: true`, and `llm_call`, `chat_turn`
  and `agent_call` all wrapped a `provider.chat()` throw at that default — so a
  step with a `retry` error strategy re-issued a truncation for its whole
  `retryCount`, each attempt billing a full cap's worth of output to hit the
  identical wall. They now mark it non-retriable via the shared
  `isRequestFault()`. Note this keys on the error **code**, not on
  `ProviderError.retriable`: that flag is only set when `toProviderError` can
  read a retriable HTTP status, so a connection reset or read timeout carries
  `retriable: false`, and gating on it would have stopped steps retrying
  ordinary network blips (#587).

- **`.gitignore` now denies `.env*` by default** and allowlists only
  `.env.example` and `.env.development`. The previous form enumerated names, so
  `.env.production`, `.env.staging` and `.env.test` were all freely
  committable. That matters more than it looks: Next's standalone build copies
  `.env` and `.env.production` into the build output and the server loads them
  at boot, so a committed `.env.production` would ship its contents inside the
  production image as well as into git. **A fork that deliberately commits an
  env file other than those two must add its own negation** — an
  already-tracked file keeps being tracked, so nothing breaks silently, but new
  changes to it will stop being picked up.

- **`.env.production` is no longer baked into the production image.**
  **Action required if you keep runtime configuration there.** `.dockerignore`
  excluded `.env` and the four `.env.*.local` names but nothing matched
  `.env.production` or `.env.staging`, so those files entered the build context
  — and Next's standalone output copies `.env` and `.env.production` into
  `.next/standalone` (`next/dist/build/index.js:325-337`), where the server
  loads them at boot. The result was a secrets file shipped inside the runtime
  image *and* silently supplying `process.env`. Both now stop: a `.dockerignore`
  rule of `.env.*` keeps them out of the context entirely (`.env.example` is
  still re-included). A fork that relied on `.env.production` for runtime
  configuration must supply those values another way — compose `env_file`,
  `docker run --env-file`, or the platform's environment settings — or they
  will read as `undefined` in a container that otherwise starts cleanly.
  `.gitignore` used to have the same hole; it is closed in the same release
  (see the `.gitignore` entry above), but that does not untrack a file already
  committed — check you have not committed one (#583).

- **The production runtime image no longer contains the Prisma CLI** — nor the
  schema, the migrations, or `prisma.config.ts`. **Action required if you run Prisma inside
  the app container.** `npx prisma …` and `npm run db:migrate:deploy` now fail
  there with a message naming the replacement rather than a bare
  `command not found`; `npm run db:seed` fails with `sh: tsx: not found`, since
  `tsx` was never in that image either. Migrations run from a new `migrator`
  image built from the same `Dockerfile`; seeding from a new `seeder` image.
  The reason is that completing the CLI's dependency closure would have meant
  shipping 133 packages / ~240 MB of deploy-time tooling — Prisma Studio, a WASM
  Postgres, a charting stack — inside the process that serves traffic. Removing
  it instead took the image from **739 MB to 402 MB** (arm64, like-for-like;
  the amd64 image CI builds measures 298 MB). What the app needs
  (`@prisma/client`, `.prisma/client`, `@prisma/adapter-pg`) arrives through
  Next's standalone trace.
  **Render, Railway and Fly.io users must change how migrations run**: all three
  execute their migration hook inside the deployed image, and Render cannot
  build a specific Dockerfile stage. Each platform guide now documents a
  supported alternative, and `.context/deployment/overview.md` carries a
  portable recipe that runs the real `migrator` image against production (#583).
- **`docker-compose.prod.yml` gained explicit `target:` and `image:` keys and a
  `seed` profile.** `migrator` builds the `migrator` target instead of the
  runtime image and takes its command from the stage's `CMD`; a new
  profile-gated `seeder` service handles `db:seed` and is never built or started
  by a plain `up`. The `image:` names reproduce Compose's existing implicit
  names, so nothing changes for existing stacks (#583).
- **The CI `docker` job now runs the production stack instead of only building
  it.** It builds three targets with `load: true`, asserts image invariants
  (musl-only `sharp`; no Prisma CLI in the runtime image), brings up
  `db` + `migrator` + `web`, and asserts the migrator exited 0, `web` reached
  healthy, and a Prisma model query succeeds. Its path filter widened to include
  `Dockerfile.dev`, `docker-compose*.yml`, `prisma.config.ts` and `prisma/**`,
  so schema PRs now run it. The job id is unchanged, so `ci-status` needs no
  edit — forks merging this will not see a conflict in that block (#583).
- **The `deps` build stage no longer takes a `DATABASE_URL` build argument.** It
  uses a fixed placeholder, because `prisma generate` only needs the DSN to
  parse. Build arguments are recorded verbatim in `docker history`, and the
  `migrator`/`seeder` images derive from `deps` — so a real production DSN would
  otherwise have been readable from a shipped image (#583).

- **Capability slugs may now contain underscores**
  (`^[a-z0-9]+(?:[_-][a-z0-9]+)*$`) and are capped at 64 characters rather than
  100, matching the provider tool-name limit the slug now has to satisfy — a
  longer one would create successfully and then be dropped from every agent's
  toolset with only a warn log to explain it. The shared slug rule allows
  hyphens only. Required by the rule above: the slug is the tool name, every built-in
  uses the underscore convention LLM tool names take, and those rows are seeded
  through Prisma without ever meeting the API schema — so without this a
  capability authored through the API could never match the convention its
  thirteen siblings use. **The charset is wider; the length is narrower.** A
  slug of 65–100 characters was creatable before and is now refused, on update
  as well as create — so an API client doing a full-object PATCH that echoes a
  legacy over-length slug gets a 400 on a field it did not change. Omit `slug`
  from the PATCH body (it is immutable anyway) or recreate the capability. The
  admin form already omits it (#509).
- **The minimum supported Node version is now 24.** Node 20 reached end-of-life
  on 2026-03-24 and receives no security patches — that alone is the reason.
  It additionally unblocks two pending major upgrades (`openai` v7,
  `@testing-library/jest-dom` v7) whose floor is ≥22; neither is a dependency
  yet. `Dockerfile` and `Dockerfile.dev` build on `node:24-alpine`,
  `package.json` declares `engines.node: ">=24"`, and a new `.nvmrc` is the
  single source the CI workflows read via `node-version-file` — previously the
  version was hardcoded in eight separate places with nothing keeping them in
  step. **A fork on Node 20 or 22 must upgrade its runtime**; `npm install` will
  warn rather than fail, because `.npmrc` does not set `engine-strict`, so the
  mismatch will otherwise surface late rather than at install (#581).
- **A capability whose slug cannot be a tool name is dropped from an agent's
  toolset with a warning** rather than sent to the provider. Providers reject the
  *entire request* over a malformed tool name, so a namespaced fork slug from the
  `register(cap, { slug })` seam — `billing:lookup_order` — would have killed the
  conversation rather than one call. Such a capability was never reachable from
  chat anyway; MCP remains its surface, and resolves custom names back to slugs
  explicitly (#509).

### Fixed

- **A cancelled stream no longer counts against the provider's circuit breaker.**
  Pressing stop, closing the tab or navigating away mid-answer raises an abort,
  and the streaming handler's inner catch recorded a provider failure before it
  checked for one. At `failureThreshold: 5`, five cancelled streams opened the
  circuit for that provider slug across **every** agent using it: one reader
  changing their mind five times could take a healthy provider offline for
  everybody. The breaker exists to route around a provider that is unwell, and a
  reader is not evidence about the provider.

  One `isClientAbort()` predicate now answers the question, consulted at the
  inner catch and — as **defence rather than a second live site** — at the outer
  one. Both shipped adapters raise an in-flight abort as
  `ProviderError('request aborted', { code: 'aborted' })`, which the outer
  catch's `ProviderError` branch returns on before it could reach the breaker,
  so a cancellation from either never got there. The outer guard covers the
  shape a fork adapter can still produce. The predicate reads the caller's
  `AbortSignal` first and a `ProviderError`'s own `code` second, and only falls
  back to matching the message when neither exists — so a provider error whose
  text happens to contain "aborted" stays a provider failure (#592).
- **A stream that dies part-way through now records what it was billed for.**
  Two halves, and neither works without the other. The **adapters** knew the
  cost and threw it away: Anthropic sets `inputTokens` at `message_start` and
  updates `outputTokens` on every `message_delta`, so at the moment the stream
  catch fires it knows exactly what the provider has charged for — and
  `toProviderError` dropped it. `toProviderErrorWithUsage()` attaches it
  instead. The **handler** folded `ProviderError.usage` into `AiCostLog` only
  inside the request-fault branch added by #593; the other two exits — failing
  over to a fallback, and giving up with no fallback left — dropped it, so a
  turn billed by two providers would have logged only the second. The fold now
  happens on the way into the catch, covering every exit in one statement.

  Together: a mid-stream failure on Anthropic that previously vanished from
  `AiCostLog` is now recorded against the agent's budget. OpenAI-compatible
  reports usage in a final chunk, so an error before that still has nothing to
  attach — and zeroed usage is deliberately dropped rather than written, because
  a zeroed row tells the dashboard the turn was free, which is a worse answer
  than no row.

  **Fork-facing: this also feeds the per-turn cost cap, not just the log.** The
  recovered spend is added to `turnCostUsd`, which `maxCostPerTurnUsd` is tested
  against — so a turn that burned most of its cap, lost the stream, and then
  succeeded on a fallback provider can now stop the tool loop early with an
  `endedReason: 'budget_exceeded'` marker where it previously ran on. That is
  the cap working on the money actually spent rather than on the subset that
  survived to a `done` chunk, but it is a behaviour change and an agent sitting
  close to its cap is where it will show (#592).

- **EPUB chapter text is now extracted by a real DOM parse, not a regex chain.**
  `epub-parser.ts` stripped markup with fourteen chained `.replace()` calls;
  CodeQL raised five high-severity findings against them on #613. Three were
  real, measured against the old code rather than assumed: `<[^>]+>` does not
  match `</script >`, so a script block written that way survived removal and
  its **body** landed in the knowledge base as text; `&amp;` was unescaped ahead
  of `&lt;`, so the literal text `&amp;lt;` double-unescaped to `<`; and only
  six entities were decoded, so `Caf&eacute;` reached the chunker verbatim —
  every book not written in English. (The other two, the "incomplete
  multi-character sanitization" pair, do not produce a live tag through either
  implementation; they are theoretical for this sink and are not claimed as
  fixed.)

  The replacement is `lib/orchestration/knowledge/parsers/dom-text.ts`, holding
  the jsdom text-extraction machinery `html-parser.ts` already had — now shared
  rather than duplicated. Both parsers use it. Alongside the correctness fixes,
  EPUB text gains proper decoding of every entity, `<head>` exclusion for free
  (it is not in `document.body`, so the regex added earlier in this release is
  gone), non-breaking spaces folded to ordinary ones, and markdown headings —
  which `chunkMarkdownDocument()` splits on, so a book now chunks along its
  chapters instead of arbitrarily.

  Verified through a production build and against the standalone server, since
  jsdom in a knowledge parser is precisely what broke this pipeline once before:
  `npm run smoke:epub`.

- **The EPUB parser returned an empty document for every book ever ingested.**
  `epub-parser.ts` called `await epub.parse()`, but `epub2@3.0.2`'s `parse()`
  returns `this`, not a promise — parsing is callback-driven and completes on an
  `end` event. The `await` resolved on the next microtask and the parser read
  `metadata`, `flow` and `toc` while all three were still empty. Measured
  against a spec-valid EPUB 2 archive, the old code returned
  `{ title: '<filename>', metadata: { format: 'epub' }, sections: 0, fullText: '', warnings: [] }`.
  Silent: the upload reported success, and any agent grounded on an EPUB had
  been answering from nothing. A second instance of the same mistake sat two
  lines below — `await epub.getChapterRaw(id)` awaits a callback-style method
  that returns `void`. Both now use the library's promise API,
  `EPub.createAsync()` and `getChapterRawAsync()`.

  **An empty result is also no longer silent.** Two paths still return zero
  sections from a *resolved* parse — a book with no spine, and one whose every
  chapter strips to nothing (an image-only comic or photo book) — and both
  looked exactly like the bug. Each now carries a warning naming the reason,
  which `document-manager` persists into the document's metadata and logs. That
  matters because `uploadDocument` derives `fileHash` from the extracted *text*,
  so every book extracting to nothing hashes to `sha256('')` and the second one
  silently dedups into the first under a different title.

  **Fork-facing:** a caller that treated `sections: []` as "an empty book" was
  reading every book that way and will now get content. An unreadable archive
  rejected before this change and still does — that was never the broken part.
  Chapter text also no longer repeats the chapter title, which leaked in from
  the XHTML `<head>`. (The library itself was then replaced — see the next
  entry, which is where the rest of this stopped mattering.)

  **What let it ship, and what stops it recurring.** `types/epub2.d.ts` — a
  hand-written declaration shadowing the library's own — declared both methods
  as returning promises. That is the only reason
  `@typescript-eslint/await-thenable`, an error under `recommendedTypeChecked`,
  stayed silent; with the declaration corrected it flags both call sites. The
  unit tests mocked `epub2` wholesale and asserted against the invented shape,
  so 27 green tests sat on top of a parser that never worked. They are kept for
  the branch cases and the mock now mirrors the real API, but the guard is a new
  no-mock suite that parses an archive built byte-by-byte by
  `tests/helpers/epub-fixture.ts`. That fixture DEFLATEs its entries on purpose:
  with stored entries `parse()` happens to complete synchronously and the bug
  does not reproduce (#606).
- **Edits to a system capability's seed-owned fields are now refused instead of
  silently reverted.** Since #545 the capability seeds re-apply
  `functionDefinition`, `executionType` and `executionHandler` to existing rows
  on every deploy whose seed-file hash changes. Nothing stopped an operator
  writing those same fields through `PATCH …/capabilities/{id}` or the config
  importer: the write succeeded, logged a `capability.update` audit entry — and
  the next re-seed undid it with **no audit entry, no log and no signal in the
  UI**. `slug` had a worse ending, because it is the key the seed upserts on: a
  rename was not reverted, it made the next re-seed create a **second row** for
  one built-in. PATCH now returns 403 naming the offending fields; the importer
  skips just those fields and records a warning, so a whole-config restore is
  not failed by a bundle carrying a built-in's shipped definition. The System
  badge and banner in the capability form now name what is protected rather than
  leaving the operator to discover it at save time. The form also stops sending
  an **untouched** `functionDefinition` for a system row: it normalises the
  stored definition on load — forcing `name` to the slug, replacing a non-string
  `description`, coercing `parameters` — so a row whose stored value did not
  already match that normalisation would have 403'd a save that only edited the
  description, naming the one field the operator has no way to fix there. An
  edited definition is still sent, and still refused with a message saying why;
  dropping it unconditionally would silently discard a deliberate edit and
  report "Saved" (#598).
- **The config importer no longer deactivates a built-in capability.**
  `PATCH …/capabilities/{id}` treats `isActive: false` on a system row as
  equivalent to deleting it and refuses; the importer applied it, and nothing
  put it back — every capability seed sets `isActive` only in its `create`
  branch, so no re-seed restores it. A hand-edited or foreign bundle carrying
  `{"slug":"upload_to_storage","isActive":false}` therefore disabled a built-in
  permanently, through the same call that declines to import that bundle's
  `executionHandler`. It is now skipped with a warning. Re-**activating** is
  still imported, exactly as PATCH still allows it (#598).

- **CI's changed-file detection no longer caps at 100 files, silently skipping
  every gate.** The `config` job read `gh pr view --json files`, which goes
  through GraphQL and pages `files(first: 100)` without following on —
  **measured: 100 of 411** against a real PR. Every gate defaults to off and is
  switched on by a matching path, and `ci-status` fails only on a literal
  `failure`, so a skipped job passes: a PR over 100 files could go fully green
  with type-check, lint, build, tests, the Docker stack smoke and the
  `lockfile` supply-chain check never having run. A release PR is exactly the
  large-diff case, and exactly when `package-lock.json` moves. PRs now use the
  REST files endpoint with `--paginate` (cap 3000) and **cross-check the result
  against the PR's own `changed_files` count**, so a future API change that
  reintroduces a cap is caught rather than trusted. Pushes use the commits API with the same
  flag — it caps at 300 *per page* but does paginate. **Both endpoints stop at a
  hard 3000 files regardless**, returning a final empty page with HTTP 200, so
  the push path treats reaching that cap as truncation (the PR path catches it
  via the cross-check instead). The
  truncation flag defaults to **true** and is cleared only by a positive numeric
  match, so a comparison that merely errors cannot leave the gates switched off.
  On any truncation the job runs **every** gate and emits a `::warning::`:
  running too much on a huge diff is the cheap mistake. Two fixes to the gate itself:
  `config` joins `ci-status`'s `needs` — every other job is gated on its
  outputs, so a failure in change detection made them all `skipped` and reported
  "CI passed" with nothing run — and `ci-status` now fails on anything that is
  not `success` or `skipped`, so a `cancelled` job (a `timeout-minutes` kill, or
  a cancelled run) no longer passes the required check (#591).
- **A truncated evaluation judge no longer records a wrong verdict.** A judge
  agent runs as a streaming chat call, so it goes through `drainStreamChat`
  rather than `runStructuredCompletion`, and the seeded judges run at
  `maxTokens: 1000` with **no** `responseFormat` — so neither adapter's
  truncation guard can fire. When a judge ran out of tokens mid-object,
  `scoreResponse` recorded `score: null, reasoning: "judge response was not
  valid {score, reasoning} JSON"` — into a metric row **an operator reads**.
  That is a wrong diagnosis, and it sent people to rewrite a judge prompt that
  was working when the fix was to raise `maxTokens`. It now distinguishes the
  two, names the output-token count, and states the remedy. Same defect as
  #587, on the feature the original report came from (#594).
- **A truncated `json_object` response is now reported as truncation on both
  adapters.** The truncation guards tested `responseFormat.type ===
  'json_schema'` specifically, so a caller asking for `json_object` — notably
  the orchestrator's planner — sailed straight through with partial JSON. It
  then failed `JSON.parse`, spent a **clarifying retry into the same token
  cap**, and surfaced as `planner_parse_failed` with `retriable: true`, inviting
  the engine to re-run the whole step at that same cap. All four guards
  (Anthropic and OpenAI-compatible, streaming and non-streaming) now cover any
  `responseFormat`: a caller asking for `json_object` wants parseable JSON just
  as much as one supplying a schema, and truncated JSON is unusable under
  either. This also removes the wasted retry and the false `retriable`, since
  the adapter now raises `truncated_no_output` before the parse and
  `isRequestFault` marks it non-retriable. The guards test
  `responseFormat.type` explicitly rather than truthiness, because
  `agent.metadata` permits only primitives — so an agent configured through the
  admin API stores the **string** `"json_object"`, and a truthiness test would
  arm the guard on a request that never reaches the API as JSON at all. On
  Anthropic the completeness test applies to `json_object` but not to the
  forced-tool `json_schema` path, whose payload is rebuilt via `JSON.stringify`
  and is therefore always valid JSON; the shared test now lives in
  `lib/orchestration/llm/json-completeness.ts` so the two adapters cannot
  drift. **Fork-facing:** a `json_object` call that previously returned a
  partial string now throws — which is the point, but a fork catching parse
  failures downstream should expect the error earlier and better-labelled
  (#594).
- **Capabilities invoked from a workflow now record a cost row.** The dispatcher
  wrote `CapabilityContext.agentId` to `AiCostLog.agentId`, but a workflow
  dispatches under a `workflow:${workflowId}` label rather than a real
  `AiAgent.id` — and that column is a foreign key to it. Postgres rejected every
  such insert with P2003 (`ai_cost_log_agentId_fkey`, reproduced against a live
  database), `logCost` swallowed the rejection into an error log and returned
  `null`, and the row was lost. So every `tool_call` step emitted an error-level
  log line and the Costs page's per-tool breakdown under-reported capabilities
  run from workflows to **zero**. The label is no longer written to that column;
  `CapabilityContext` gained an optional `workflowExecutionId`, which the
  `tool_call` executor sets from `ctx.executionId` and which maps to
  `AiCostLog.workflowExecutionId` — a real FK, satisfied because the execution
  row exists before any step runs. **Fork-facing:** these rows appear where none
  did before. No agent's `checkBudget()` total moves — it sums by `agentId`, and
  these rows never existed to be counted. **Scope of the fix, stated precisely:**
  the row persists and carries `workflowExecutionId`, so it is queryable by
  execution and the per-capability stats route (`operation: 'tool_call'` +
  `metadata.slug`) reports it instead of zero. It does **not** yet show in the
  execution detail or live cost panels, which key on `metadata.stepId` and skip
  any row without one — `tool_call` rows carry `{ slug, success }`. Completing
  that, and the same `workflowExecutionId` for capabilities dispatched from an
  `agent_call` step, is tracked in #600. Pre-existing, found by review of #528.
- **Scheduled `tool_call` steps no longer fail on a cold process.**
  `engine/executors/tool-call.ts` dispatched straight into the capability
  registry without calling `registerBuiltInCapabilities()` first, unlike the
  chat handler, the MCP tool registry and `agent_call`. #462 made the registry
  a `globalThis` singleton so a registration in one module realm is visible
  from all of them, but the *trigger* stayed lazy behind module-scoped
  booleans — so the map is only populated once something calls the initialiser,
  and all three callers that do are reached by an HTTP request. The scheduler
  is not. A server that had served nothing since boot dispatched into an empty
  map and the step failed `unknown_capability` naming a slug that was
  registered perfectly well. It presented as a fork bug (the message names the
  fork's own slug) and was worst exactly when it mattered: an overnight-quiet
  process is precisely the one running a 03:15 scheduled workflow. Under load
  it hid, and no unit suite could see it — tests register explicitly in setup,
  so their registry is never empty. Reported from a fork whose four scheduled
  workflows are built almost entirely from `tool_call` steps (#537).
- **`CAPABILITY_BINDING_MODE=strict` no longer breaks every workflow
  `tool_call` step.** A workflow execution isn't bound to an agent, so the
  executor dispatches under a synthetic `workflow:${workflowId}` label. Under
  `strict` a missing `AiAgentCapability` row denies — and that row **cannot be
  created**, because `AiAgentCapability.agentId` is a foreign key to
  `AiAgent.id` and the FK rejects a `workflow:` id. So enabling strict as a
  hardening measure failed every `tool_call` step in every workflow with
  `capability_disabled_for_agent` and no configuration that fixed it; because
  the error is per-step it read as a capability misconfiguration, sending an
  operator to audit a table that was already correct. Workflow labels are now
  exempt and fall through to the base capability's defaults in both modes.
  **Semantics change, deliberate:** `strict` no longer covers workflow
  `tool_call` steps at all. It is about an *agent* reaching a capability it was
  never granted, and all three agent-facing paths take the tool name from a
  model — whereas a step's `capabilitySlug` is Zod-parsed config on an
  admin-authored workflow (`withAdminAuth` on every workflow write route), so
  the step *is* the grant — a **workflow-scoped** one. **Read this before
  relying on strict as a revocation:** its guarantee is _agent_-scoped and does
  not follow into a workflow. An agent bound to `run_workflow` names the
  workflow as a tool argument, so every capability inside any workflow its
  `customConfig.allowedWorkflowSlugs` permits runs under that workflow's label —
  including one you revoked from the calling agent. Neither deleting the binding
  row nor `isEnabled: false` closes that, because the workflow path consults no
  binding at all; `isActive: false` and quarantine do, because both deny before
  any binding is read. **Fork-facing:** the prefix is now the shared constant
  `WORKFLOW_AGENT_ID_PREFIX`, with `workflowAgentId()` and `isWorkflowAgentId()`
  beside it — on `lib/orchestration/capabilities/dispatcher.ts` and re-exported
  from the `@/lib/orchestration/capabilities` barrel. Mint and test the label
  through those rather than re-inlining the template, which is how the executor
  and the dispatcher came to disagree. `permissive` (the default) is
  behaviourally unchanged; it now skips a query that could only ever return
  zero rows (#528).
- **Built-in capability seeds now re-apply their function schema on re-seed.**
  Every `AiCapability` upsert wrote `functionDefinition`, `executionType` and
  `executionHandler` on `create` only, so once a row existed the DB — and
  therefore the MCP tool list and everything the LLM is shown — kept
  advertising the **original** schema forever. Reported from a fork that added
  a parameter to a capability: every test stayed green and the new field never
  appeared on dev or prod. The tests could not catch it because they pin the
  capability class against the seed constant, not the seed constant against the
  DB write.

  The code-owned fields are now hoisted into one constant per seed and spread
  into both branches, so they cannot drift.
  `tests/unit/prisma/seeds/capability-code-owned-fields.test.ts` parses every
  seed and enforces it, including for seeds not yet written.

  **`005-pattern-advisor` changed in the other direction:** it was the one seed
  re-applying `name`, `description` and `category`, which silently reverted an
  operator's renames on every deploy. Those are admin-UI presentation and are
  now left alone — what the LLM reads lives inside `functionDefinition`, which
  is still re-applied. `isActive` and `rateLimit` were never touched and still
  aren't. See [`.context/database/seeding.md`](./.context/database/seeding.md)
  for the ownership rule (#545).

- **Three built-in capabilities were advertising a stale schema to the LLM.**
  Separate from the propagation bug above and found while fixing it: the seed
  constants had drifted from the capability classes that actually validate and
  run. `call_external_api` never gained the `multipart` parameter (named file
  parts, for endpoints like document renderers), so no agent could use it;
  `apply_audit_changes` was missing `deploymentProfiles`; `add_provider_models`
  carried several out-of-date parameter descriptions. All three now match their
  class exactly, enforced by
  `tests/unit/prisma/seeds/capability-class-seed-parity.test.ts` — a
  deep-equality check per capability, since a name-only comparison would have
  missed the descriptions, and a description is how the model picks a
  parameter (#545).

- **A truncated response is no longer reported as a schema failure on the
  `runStructuredCompletion` and provider-adapter paths.**
  `runStructuredCompletion` never read `finishReason`, so a response cut off at
  the token cap arrived as text its `parse` rejected — indistinguishable, from
  the content alone, from a model that ignored the schema. Both attempts burned
  and the caller was told the contract was broken, which sent operators to edit
  a schema that was never wrong. Reported from a fork whose production judge
  failed with `"Judge response was not valid against the schema after one
  retry"` and an empty issue list — reading as "no schema problems found"
  rather than "we never got JSON" — when the real fault was a 2048-token cap on
  a reasoning model, where the cap covers hidden reasoning tokens as well as
  visible output. The error now names the truncation and the cap on the three
  routes that can detect it: both provider adapters and the runner, which
  raises it once both attempts are spent. **Two in-repo paths are not covered**
  and are tracked separately: evaluation judge agents go through
  `drainStreamChat`, whose `done` event carries no finish reason, and the
  orchestrator planner uses `json_object` rather than `json_schema` (#594)
  (#587).

- **`truncated_no_output` gains user-facing chat copy.** It had no `ERROR_MAP`
  entry, so `getUserFacingError` fell through to the generic "Something went
  wrong" — the actionable detail reached the server log and the trace but never
  the person who could act on it. The copy is deliberately vaguer than the
  underlying `ProviderError`, because this registry is rendered by whatever
  client is attached, a fork's end-user surface included. Note the bundled
  embed widget does **not** consult it — it renders a fixed
  `'Something went wrong.'` for every error event — so this reaches the admin
  chat interface and any client that calls `getUserFacingError` (#587).

- **`CI_NODE_HEAP_MB` now reaches the Docker build.** A workflow-level `env:`
  does not cross into a container build, so raising the variable moved
  `typecheck`, `lint` and `build` while the `docker` job stayed pinned at the
  `builder` stage's hardcoded 4096 — a fork that outgrew the default got a green
  board with one permanently red job, OOMing at exactly 4128 MB, and a knob that
  appeared to do nothing. The cap is now a `NODE_HEAP_MB` build arg. The
  Dockerfile default is unchanged at 4096, so a bare `docker build` and a
  self-hosted compose build behave exactly as before; the `docker` CI job
  forwards `CI_NODE_HEAP_MB` (so it now builds at 5120 by default, matching
  every other job rather than lagging them), and `docker-compose.prod.yml`
  exposes `NODE_HEAP_MB` so a self-hosted build has the same lever. Base Sunrise never
  hit this — 4096 is enough for the template — so it only affected forks, which
  is the population the variable exists for. Reported and verified in a fork by
  @JohnD-EE (#543).

- **The production Docker stack could not start at all.**
  `docker compose -f docker-compose.prod.yml up` never reached the app: the
  `migrator` service exited **127** (`sh: prisma: not found`), and `web` waits
  on `service_completed_successfully`, so it never ran. Two independent faults,
  both in the `runner` stage: `node_modules/.bin` was never copied, so there was
  no `prisma` shim — and because a *partial* `node_modules/prisma` was present,
  `npx` found the package, stopped looking, and never fell back to a registry
  fetch (which is how this worked before the Prisma CLI was added to the image).
  Second, the CLI's dependency closure was absent, so invoking the entry point
  directly gave `Cannot find module 'effect'`. Broken since 2026-04-15 and
  invisible because CI built the image and never ran it (#583).
- **`docker compose … exec web npm run db:seed`, documented as REQUIRED on first
  install, never worked.** `db:seed` is `tsx prisma/seed.ts`; `tsx` is a
  devDependency and the seed units import from `lib/`, so neither the runner nor
  any tool it contained could run it. Seeding now has its own image (#583).
- **Two deployment docs told you to run `curl` inside the container.**
  `node:24-alpine` does not ship `curl`, so `exec -T web curl -f …` failed
  regardless of application health. Run health checks from the host, or use
  `wget -qO-` inside (#583).

- **`package-lock.json` declares `libc` again on every native Linux package that has one.**
  Production is `node:24-alpine` (musl) and `libc` is the only field separating
  `@img/sharp-linux-x64` from `@img/sharp-linuxmusl-x64` — both are otherwise
  just `os: linux, cpu: x64`. Without it a musl install resolves **both**
  variants: measured, `node_modules` went 2.4 GB → 2.0 GB once the field was
  restored, with `sharp-linux-x64`, `sharp-libvips-linux-x64`,
  `swc-linux-x64-gnu` and `oxide-linux-x64-gnu` no longer landing in a musl
  image. Nothing errored, which is why it survived a release. The cause is
  **npm below 11.11.0**, not macOS as previously documented: `@npmcli/arborist`
  omitted `libc` from its serialised field list until 9.4.0, so every write
  deleted the key on every platform, while dependabot's newer npm kept adding
  it back. Restored from each package's registry manifest at its exact locked
  version — no version moved, nothing added or removed, 303 insertions and zero
  deletions across the 101 packages that carried the field at the time. That
  count tracks the dependency graph, not this fix: at 0.9.0 it is 70, and
  `npm run fix:lockfile-libc -- --check` reports the lockfile complete, with the
  21 remaining Linux packages declaring no `libc` upstream. Check the state, not
  the number. Forks on 0.8.0 or later inherit the fault and should take this
  merge (#571).
- **The capability admin form no longer degrades a stored tool schema when you
  edit it.** The visual builder holds four fields per parameter — name, type,
  description, required — and rebuilt each parameter from those alone, so
  saving deleted every keyword it had no slot for. Editing one description
  stripped `minimum`/`maximum` from the parameter beside it, and `integer` was
  silently widened to `number`, letting a model send `1.5` where a whole number
  was required. Merely *opening* a seeded capability and pressing Save was
  enough. A compile now merges over the stored spec: the builder owns type,
  description and required-ness, and everything else is carried through. A
  deliberate type change still drops the stored keywords, which is the one case
  where losing them is correct. Not previously reachable through the UI — the
  client slug rule rejected every seeded capability's underscore slug and
  blocked the save — so this ships as a fix alongside the change that removed
  that accidental brake (#509).
- **A capability rename now pins its MCP tool name instead of moving it.**
  `tools/list` advertises `customName ?? functionDefinition.name` and
  `tools/call` resolves an incoming call by whatever was advertised — so
  forcing the name to equal the slug would have renamed the published tool,
  and an external client calling the old name would get `Unknown tool`. Every
  capability created through the admin UI before this release diverged by
  default (`search-web` slug, `search_web` function name), so an ordinary save
  — reword a description, change a rate limit — was enough to break someone
  else's integration, silently and from a form that never mentions MCP.
  A write that displaces the function name now copies the old one into
  `customName` first, in the same transaction, so the external contract stays
  where it was while the internal invariant is repaired. Rows that already set
  `customName` are untouched, and a displaced name that could not legally live
  in `customName` (`^[a-z][a-z0-9_]*$`) is not written — that rename proceeds
  and is logged, because writing it would fail validation the next time
  anyone edited the MCP row (#509).

- **Vercel builds no longer fail with `ENOENT: .next/next-server.js.nft.json`.**
  `next.config.js` set `output: 'standalone'` unconditionally, for Docker
  self-hosting. From Next 16.3.0, Turbopack stops emitting
  `next-server.js.nft.json` when a deployment adapter drives the build
  ([vercel/next.js#93684](https://github.com/vercel/next.js/pull/93684)) — but
  standalone output reads that file, so the two together break the build at
  `onBuildComplete`. `output` is now `undefined` when `VERCEL` is set; Vercel
  never used standalone, and Docker is unaffected. Forks that hardcode
  `output: 'standalone'` back will hit this on Vercel while Docker keeps
  working, and the local build will not reproduce it — with no adapter present,
  Next still generates the file. See
  [`.context/deployment/platforms/vercel.md`](.context/deployment/platforms/vercel.md).

## [0.8.1] — 2026-08-06

> **Alpha release.** Eleventh tagged Sunrise release. **PATCH bump** — one
> dependency fix, no public-surface change, no migration. Forks can take this
> with a plain `git merge v0.8.1`.
>
> **Take this if you are on 0.8.0.** The v0.8.0 lockfile hoists a `ws` version
> inside a high-severity advisory, so a fork that merged 0.8.0 is running the
> vulnerable copy whether or not anything told it so.
>
> **Most forks will not have been warned.** `dependency-review` is diff-based:
> once the vulnerable version sits on `main`, no later PR "introduces" it and
> the job stays green — upstream and downstream alike. A fork only sees an
> alert if its own `main` had already patched `ws` independently, because then
> the sync merge reads as a *downgrade*. That is the inverted case — the forks
> that get blocked are the ones that had already fixed themselves, while the
> forks still carrying the vulnerability sync silently. Do not read a green
> sync PR as evidence you are unaffected; check the hoisted `ws` version in
> your lockfile.
>
> **If you worked around it with an `overrides` entry**, drop it when you take
> this release. Forcing `ws` above the old `~8.20.1` pins was never in-range
> for the two packages that declared them; the transitive bump below is, so
> the override is no longer buying anything and is actively masking the
> resolution.

### Security

- **`ws` lifted out of GHSA-96hv-2xvq-fx4p** — memory-exhaustion DoS from tiny
  fragments and data chunks, high severity, affected `>=8.0.0 <=8.20.1`. The
  vulnerable copy was held in place by two transitive packages reached via
  `react-email` → `socket.io`, whose `~8.20.1` tilde pins excluded the patched
  line. Refreshing just those two — `engine.io` 6.6.8 → 6.6.9 and
  `socket.io-adapter` 2.5.7 → 2.5.8, both of which widened to `~8.21.0`
  specifically to pick up patched `ws` — lets `ws` hoist to `8.21.2` on its
  own, and every consumer (`jsdom`, `openai`, `happy-dom`, and the two above)
  is satisfied natively. Lockfile-only: no `overrides` entry, no
  `package.json` change, and no direct dependency moved (#538).

## [0.8.0] — 2026-08-04

> **Alpha release.** Tenth tagged Sunrise release. **MINOR bump** — a large
> batch: an issue burn-down and a security sweep on top of new fork-facing
> surface.
>
> **Security.** An email change now requires approval at the **old** address,
> the current password, and revokes the account's other sessions (#489) —
> _breaking for API callers_, since `PATCH /api/v1/users/me` no longer moves the
> address in-request. Chat dispatch refuses tool names outside the agent's
> advertised set (#476); `sanitizeUrl()` closes a control-character scheme
> bypass (#437); JSON API responses carry `Cache-Control: private, no-cache`
> (#487); and schedule- and inbound-triggered runs are written system-owned, so
> erasing the operator who configured a trigger no longer destroys third
> parties' inbound conversations (#502 — **ships migration
> `20260801090000_system_owned_inbound_runs`**, which backfills inbound history).
> That is one of **two migrations** in this release; the other,
> `20260730140000_add_message_role_createdAt_index`, is the index the embedding
> backfill's anti-join needed (#442).
>
> **Added.** The subject-access (GDPR Art. 15) export seam, matching erasure
> (#467); `SIGNUP_MODE` to run a fork invite-only (#463); the authenticated-nav
> and post-authentication landing seams (#473); private objects end-to-end in
> storage, with a signed read route and a private root on the local provider
> (#490); fork-owned seams at user creation (#464), for recurring app work
> (#469), and for third-party frame hosts (#450); agent-opened chat turns and
> caller message metadata (#474, #475); `apiClient.put()` (#495);
> `validatePathParam()` (#435); `slugify()` (#451); and a configurable
> dev-server port.
>
> **Changed.** `HookEventType` and the email-kind registry open to fork-owned
> values (#465, #468) — the first is _breaking_ for an exhaustive `switch` with
> an `assertNever` default, deliberately. `prisma/schema/app.prisma` is now
> genuinely fork-reserved and ships empty, its three platform models moved to
> `platform.prisma` with no migration and no client change (#429). An idle
> maintenance tick now does zero database work (#442).

### Security

- **Changing an account's email now requires approval at the old address, the
  current password, and revokes other sessions.** ([#489]) `PATCH
  /api/v1/users/me` wrote the new address straight in and mailed verification to
  it, with no re-authentication and no signal to the address being replaced — so
  a single compromised session converted into permanent account takeover: the
  address moved, the link went to the attacker, and `autoSignInAfterVerification`
  minted them an independent session. A session expires; control of the address
  does not.

  The endpoint now delegates to better-auth's `changeEmail` with
  `sendChangeEmailConfirmation`, which writes nothing until the address
  **currently** on the account approves — so a stolen session can request a
  change but not finish one. On top of that, `currentPassword` is required
  (OAuth-only accounts are exempt, having none), and the user's other sessions
  are revoked when the change lands.

  **Breaking for API callers:** an email change no longer takes effect in the
  request. A success response carries the *old* `email` plus
  `emailChangeRequested: true`, and the address moves only after approval at the
  old address and verification at the new one. Sending `email` without
  `currentPassword` is now a 400 on password accounts.

  New public surface: `changeEmailApproval` in the email registry (overridable
  in `lib/app/emails.ts`), `revokeUserSessions` (`lib/auth/sessions.ts`), and
  `parseEmailChangeToken` (`lib/auth/change-email.ts`) — the last is required
  reading before touching `sendVerificationEmail` or `afterEmailVerification`,
  since better-auth routes email changes through both with no discriminator of
  its own.

- **The chat handler now refuses tool names outside the agent's advertised
  set.** Dispatch previously took the tool name straight off the model's emitted
  call, while the dispatcher synthesizes a default-ALLOW binding when no
  `AiAgentCapability` row exists — so a capability an agent was never granted
  would execute, unrestricted. Reachable via prompt injection, or via a
  conversation resumed across a capability being revoked (the model's own
  earlier calls sit in history and invite imitation). ([#476])

- **`sanitizeUrl()` no longer passes control-character-obfuscated schemes.**
  `java<TAB>script:`, `java<LF>script:`, `javascript<TAB>:` and a leading C0
  control all bypassed the check, because it ran on `trim()` (leading/trailing
  whitespace only) while browsers strip tab/newline/CR from anywhere in a URL
  before parsing the scheme. The replacement character class also covers the
  non-ASCII whitespace `trim()` used to remove (NBSP, BOM, U+2028, the U+2000
  block, ideographic space), so the guard is nowhere narrower than the one it
  replaced — those are not browser-executable, but leaving them out would have
  been a silent narrowing. Only the inspected copy is normalised — the URL
  returned to callers is unchanged. ([#437])

- **`PATCH /api/v1/users/me` clears `emailVerified` when the address changes**
  and re-sends verification. Previously an account that verified one address
  could become a *verified* holder of any unregistered address in one request,
  turning `user.email` from "an address this person controls" into "any unused
  string they typed" — a privilege-escalation primitive for invitation
  redemption and domain allowlists keyed on the address. ([#466])

- **An API key can no longer change the account's email address** (#466,
  found reviewing that fix). `withAuth` accepts an API key of **any** scope, and
  keys are self-service — so a `chat`-scoped key handed to a third-party
  integration could have moved the account to an attacker's address, and the new
  verification mail would have delivered them a working token. With
  `autoSignInAfterVerification` enabled that token mints a real session, turning
  a read-ish scope into full account takeover. `PATCH /api/v1/users/me` now
  returns 403 on the email path for key-authenticated callers, via the new
  `isApiKeySession()` in `lib/auth/api-keys.ts`. Non-identity profile fields are
  unaffected. Re-authentication, old-address notification and session revocation
  remain open — tracked in #489.

- **JSON API responses now carry `Cache-Control: private, no-cache`** (#487).
  Nothing set a cache directive, and a response with a validator (an `ETag`,
  which several routes send) but no freshness information is *heuristically
  cacheable* — RFC 9111 §4.2.2 lets a shared cache store it and invent an expiry.
  Applied in `successResponse`/`errorResponse` and the 304 from
  `checkConditional`, so the 200 and 304 on an endpoint agree. Deliberately
  `no-cache` rather than `no-store`, which would forbid the client copy and
  defeat the conditional-GET path the ETags exist for. It is a default, spread
  before caller headers, so a route serving genuinely public data can override
  it; routes returning a raw `Response` never pass through here.

- **Schedule- and inbound-triggered runs are no longer attributed to the
  operator who configured them.** ([#502]) The inbound route stamped
  `trigger.createdBy`, and the scheduler `schedule.createdBy`, onto the
  conversation and execution rows they created. The data on those rows belongs
  to whoever sent the message — `inputData.trigger` is the adapter payload
  written verbatim (sender phone number, email From/Subject/body, base64
  attachments), and the conversation carries `fromAddress` and the full thread.

  Both `userId` columns are `onDelete: Cascade`, so **erasing one operator
  destroyed every third party's inbound conversation and run routed through any
  trigger they had configured** — `eraseUser()` reported success and the
  correspondence was gone. The same rows matched that operator on `userId`, so
  a subject-access export would have disclosed a stranger's phone number and
  email bodies to them as their own data.

  Those rows are now written system-owned (`userId = null`), which is what
  `.context/privacy/data-erasure.md` always described and what the engine was
  already built for. Migration `20260801090000_system_owned_inbound_runs`
  backfills inbound history; historical *scheduled* runs keep their author,
  because the scheduler set no `triggerSource` before this release and they
  cannot be distinguished from runs an admin started by hand.

  Three behaviour changes follow. New public surface:
  `lib/orchestration/access/execution-access.ts`
  (`adminCanViewExecution`, `executionAccessBasis`, `executionVisibilityWhere`).

  - **Admin visibility.** All 15 execution routes (including the sidebar
    counts and the live-engine dashboard, the latter via
    `getLiveEngineSnapshot`) and the conversation list, detail and search now
    admit rows nobody owns — otherwise every scheduled and inbound run would
    vanish from the UI and a run paused at an approval gate could never be
    cleared. The same widening covers three surfaces that reach execution and
    conversation rows by other routes: the resume path on `POST
    /workflows/:id/execute?resumeFromExecutionId=` (without it an approved
    system-owned run could not be continued and sat in `pending`),
    `GET /observability/dashboard-stats` (which otherwise reported a healthy
    deployment while the live-engine dashboard showed the same runs failing),
    and `POST /evaluations/datasets/:id/capture` (which otherwise 404'd on
    every attempt to capture a scheduled run's output into a dataset).
    `AccessBasis` in `conversation-access.ts` gains a third member, `'system'`,
    which is audit-logged like `'shared'`. Conversation PATCH/DELETE accept
    `'owner'` and `'system'` (still never `'shared'`), so an inbound thread can
    be deleted when the person who sent the messages asks — they have no
    account, so `eraseUser()` cannot reach them. Both mutations write an audit
    row: PATCH logs `conversation.updated` with `metadata.fields` naming what
    changed (not the values, so a renamed `title` doesn't put message content
    in the log).
  - **A resumed run keeps the user context it was created with**, alongside its
    already-pinned `versionId` and persisted `scope` — the execute route passes
    the execution row's `userId`, not the resuming admin's. Otherwise a
    system-owned run's second half would gain a user context its first half
    never had, and `judge_call` would file a stranger's transcript into the
    approving admin's history. For an owner-resume the two are the same value.
  - **`judge_call` cannot run on a scheduled or inbound workflow.** It drives
    `streamChat`, which files the judge transcript into a real account's chat
    history; borrowing the schedule's author would re-create the
    mis-attribution. The step throws `judge_call_requires_user_context`.
  - **Rerun inherits the original's attribution** rather than claiming the run
    for the admin who pressed the button, since `inputData` is copied verbatim.

  `AiWorkflowExecution.triggerSource` is now written as `'schedule'` by the
  scheduler — the value the schema documented and the scheduler never set — so
  a run with no owner still has provenance.

### Added

- **`PORT` and `EMAIL_PORT` are now read from the project's env files, so an app
  can declare the port it binds** — Next's CLI binds `--port` to `PORT` at
  argument-parse time, which happens before it loads any `.env` file. A `PORT=`
  line in `.env.local` was therefore visible to the app and invisible to the
  server hosting it, leaving `-p` on the command line as the only way to move a
  dev server. For anyone running several Sunrise-derived apps side by side —
  reverse-proxying `*.test` hostnames to loopback ports, say — that meant
  remembering which app owned which port, every time.

  `npm run dev`, `npm run start` and `npm run email:dev` now go through
  `scripts/dev-server.mjs`, which reads *only* the port variable out of the env
  files, in Next's own precedence order, and passes it to the child process.
  Resolution runs explicit `-p` flag → real environment variable →
  `.env.<NODE_ENV>.local` → `.env.local` → `.env.<NODE_ENV>` → `.env` → `3000`,
  so every existing way of setting the port keeps working and keeps outranking
  the files. Nothing else about env loading changes, and the port stays
  independent of `NEXT_PUBLIC_APP_URL` / `BETTER_AUTH_URL` — bind loopback,
  advertise the proxied hostname.

  `EMAIL_PORT` does the same for the React Email preview server, which also
  defaults to 3000 and would otherwise collide with an app; it has no env
  binding of its own, so the launcher passes `-p`.

  The launcher is plain `.mjs` with no runtime dependency: `npm start` must
  survive a production install (`npm ci --omit=dev`), which prunes both tsx and
  dotenv. Without dotenv it still starts the server and says it could not read
  the files. Deployed containers are untouched — the Docker image runs the
  standalone server, which reads `process.env.PORT` directly.

  **For forks:** Sunrise now ships a committed `.env.development` setting
  `PORT=3010` — the one env file `.gitignore` deliberately permits, for
  non-secret settings that should travel with the repo. `npm run dev` needs no
  arguments in any clone. **Change the value in your fork:** two Sunrise-derived
  apps that both keep 3010 collide the moment they run together. See
  [`CUSTOMIZATION.md`](./CUSTOMIZATION.md#claiming-your-own-dev-port).

  Deployment is untouched. The production image copies only the standalone
  build, so neither `.env.development` nor `scripts/` reaches it; `ENV PORT=3000`
  is a real environment variable, which outranks any file; Vercel runs
  `next build` and never `npm start`; and `npm start` resolves against
  `.env.production*` / `.env`, never `.env.development`.

- **Server components now call their own API at an address the server can
  actually reach** — `getBaseUrl()` returned `BETTER_AUTH_URL`, so a server
  component rendering a page went *out* to the public hostname and back in.
  Point that hostname at a local reverse proxy terminating TLS with a
  certificate Node does not trust (Herd, Valet, mkcert) and every self-call
  fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` — while the browser works
  perfectly, because it trusts the same CA the server doesn't. Pages that catch
  fetch errors then render empty: an admin user list reporting "No users found"
  against a populated database.

  `getBaseUrl()` (`lib/api/server-fetch.ts`) now resolves
  `INTERNAL_API_URL` → `http://127.0.0.1:$PORT` in development when the port is
  known → `BETTER_AUTH_URL`. Production behaviour is unchanged unless
  `INTERNAL_API_URL` is set explicitly, which is there for the same split in
  other environments — a private network where the public hostname resolves
  elsewhere. Beyond correctness, a self-call over loopback skips a round trip
  through the proxy.

  `INTERNAL_API_URL` is validated as a URL in `lib/env.ts`. It must be **this**
  app's own address; anything else would receive cookie-bearing internal
  requests.

  **New `getPublicUrl()`, and a rule for choosing between the two.**
  `getBaseUrl()` had been doing two jobs: addressing the app's own API, and
  building URLs for *other* systems to call — the inbound-webhook endpoint an
  operator pastes into Slack (`app/admin/orchestration/triggers/**`). Those
  answers are no longer the same, so a loopback internal address would have been
  rendered as a webhook URL reachable from nowhere but the developer's machine.
  `getPublicUrl()` returns the public address for anything that leaves the
  server; `getBaseUrl()` stays internal-only. The two trigger pages now use it,
  restoring exactly their previous output.

- **Hot reload now works when the app is served on a hostname rather than
  `localhost`** — Next allows only `localhost` to reach its dev endpoints and
  blocks the rest, so an app behind a local reverse proxy rendered fine but
  never hot-reloaded, logging _"Blocked cross-origin request to Next.js dev
  resource"_. Rather than have every fork hardcode its own hostname,
  `next.config.js` now derives `allowedDevOrigins` from the hostnames already in
  `NEXT_PUBLIC_APP_URL` and `BETTER_AUTH_URL`. Setting those to the proxied
  hostname is enough; the config never needs editing.

  New optional `ALLOWED_DEV_ORIGINS` adds hosts those URLs don't cover (a LAN IP
  for device testing, or a `*.myapp.test` wildcard for subdomain-per-tenant
  development). It is distinct from `ALLOWED_ORIGINS` — that is API CORS in
  every environment, this is hot reload in `next dev`, and Next ignores it in
  production builds.

- **Subject access (GDPR Art. 15) now has a seam, matching erasure** (#467) —
  Sunrise implemented the *erasure* half of GDPR carefully — `eraseUser()`, a
  documented per-table `onDelete` policy, an append-only receipt, a registration
  seam for app-owned cleanup — and had nothing at all for the *access* half.
  Every fork holding personal data wrote it themselves, each one independently
  re-answering the same question: which tables count?

  `exportUserData()` (`lib/privacy/export-user.ts`) assembles one subject's
  record from `SUBJECT_DATA_SOURCES` (`lib/privacy/export-sources.ts`), a
  manifest where every `User`-linked model carries an explicit disposition:
  `export` for the subject's own data, `attribution` for org config they
  authored (id + label + date — `createdBy` is attribution, not ownership, the
  same reasoning erasure uses when it retains the row and nulls the link), or a
  documented exclusion with a written reason. The export's own `meta` echoes all
  three back with row counts, so a subject can see the boundary of what they
  received rather than infer it.

  **The coverage guard is the substance of the change.**
  `tests/unit/lib/privacy/export-sources.test.ts` parses `prisma/schema/*.prisma`
  and fails if a model relating to `User` is missing from the manifest — so
  adding a table without deciding what a data subject receives breaks the build.
  Erasure gets this free: a missing `onDelete` throws `P2003` and breaks loudly.
  Access has no natural loud failure — an export that omits a table looks
  exactly like a complete answer to the person reading it, and neither they nor
  the operator who sent it can tell. Two consequences follow: sources use
  Prisma's `omit` rather than `select`, so a column added tomorrow is exported
  by default instead of silently dropped (what's omitted is credential material
  only — session tokens, password hashes, OAuth tokens, key hashes, HMAC
  secrets); and nothing is best-effort, so a source that throws fails the whole
  export, the deliberate opposite of the erasure path where hook failures are
  swallowed so app trouble can never block a deletion.

  Two sources shipped narrowed, disclosing it via a `scopeNote` in `meta`:
  inbound conversations and inbound-triggered workflow runs were written
  against the operator who configured the channel, not the person who sent the
  message, so matching on `userId` alone would have disclosed a third party's
  phone number and correspondence to the wrong subject. **Both filters were
  removed later in this same release** once [#502] fixed the mis-attribution
  they contained; a source that narrows must still carry a `scopeNote`.

  A second guard,
  `npm run smoke:export`, runs in CI beside the erasure smoke and proves against
  real Postgres what a mocked suite cannot: that every manifest query executes, and
  that a planted session token, password hash, key hash and webhook secret
  appear nowhere in the serialised bundle.

  New public surface: `exportUserData()` and `SubjectNotFoundError`
  (`lib/privacy/export-user.ts`), the `SUBJECT_DATA_SOURCES` / `EXCLUDED_SOURCES`
  manifest (`lib/privacy/export-sources.ts`), the fork seam
  `collectAppSubjectData()` (`lib/app/data-export.ts` — a static function rather
  than a boot-time registry like `erasure-hooks.ts`, because an unregistered
  export collector yields a bundle that looks complete and is not), and two
  endpoints mirroring the erasure pair: `GET /api/v1/users/me/export` (refuses
  API-key sessions — a `chat`-scoped key must not read out an entire account)
  and `GET /api/v1/users/[id]/export` for admins answering a request that
  arrives by email. Both take the `exportLimiter` sub-cap and send
  `Cache-Control: no-store`. Documented in `.context/privacy/data-export.md`.

- **`SIGNUP_MODE`, the seam to run a fork invite-only** (#463) — Sunrise ships a
  complete invitation system whose premise is that access is *granted*, beside an
  email/password signup endpoint that was unconditionally open with no config to
  close it. A fork whose product is invite-gated could only edit a core auth file
  or leave the front door open, which is easy not to notice: the invite flow
  works, the product *looks* gated, and accounts accumulate. `SIGNUP_MODE=invite_only`
  closes `POST /api/auth/sign-up/email` (better-auth `hooks.before`), every other
  un-invited account creation (`userCreateBeforeHook`, default-deny and
  deliberately path-independent — a Google signup arrives via `/callback/:id` and
  an ID-token sign-in via `/sign-in/social`, so an endpoint allowlist leaks
  silently), and the `/signup` page (proxy redirect). Only account *creation* is refused; sign-in,
  password reset and invitation acceptance are unaffected. New
  `lib/auth/signup-mode.ts` exports `isInviteOnly()`, `isFirstHumanBootstrap()`
  and `runInvitedSignup()` — the last being how a server-side path that has
  already validated an invitation exempts itself, since better-auth routes
  `auth.api.*` through the same hook as HTTP requests. `open` remains the default.

- **`lib/app/protected-nav.ts`, the authenticated-nav seam** (#473) — the nav a
  fork's *users* see was a hardcoded array in
  `components/layouts/protected-nav.tsx`, while the nav its *visitors* see had
  had a seam since #347. Set `protectedNavItems` to a `ProtectedNavItem[]` (from
  the new `lib/protected-nav/types.ts`) and it replaces `DEFAULT_PROTECTED_NAV`
  wholesale; `null` keeps the default. Items gain `exact?` (matching the public
  nav) and an optional `icon`, and the platform keeps owning admin filtering and
  active-state, so `adminOnly` works on a fork's own items.

- **`lib/app/auth-landing.ts`, the post-authentication landing seam** (#473) —
  `/dashboard` was hardcoded at a dozen decision sites across twelve files, with
  no config or scaffold, so an app whose product lives elsewhere edited all of them
  and re-resolved them on every upgrade. `appAuthLandingRoute` /
  `appAuthLandingLabel` (both `null` = platform default) resolve once through the
  new `lib/auth-landing/route.ts` (`AUTH_LANDING_ROUTE`, `AUTH_LANDING_LABEL`),
  now consumed by login, OAuth, signup, invite acceptance, email verification,
  the protected layout's brand link, the admin header and sidebar, both error
  pages and `proxy.ts`. The label moves with the route, so the user-visible copy
  on those controls stops saying "Dashboard" once a fork has moved. A route that
  is not root-relative throws at module load rather than becoming an off-site
  redirect via `safeCallbackUrl()`'s unvalidated fallback.

- **`apiClient.put()`** (#495) — the client exposed `get`/`post`/`patch`/`delete`
  and no `put`, so a fork building a genuine whole-resource replacement (a
  sub-resource collection such as tags, members or assignees) had to choose
  between editing `lib/api/client.ts` — a merge conflict on every upgrade — and
  shipping `PATCH` for something that is really a `PUT`. Same signature and same
  `request()` plumbing as `patch`; no behaviour change for existing callers.

- **`StorageCapabilities` on the storage provider interface** (#490) —
  `getStorageCapabilities(provider)` in `lib/storage/providers/types.ts` resolves
  what a backend can actually do (`privateObjects`, `signedUrls`, `download`), so
  callers stop sniffing `provider.name` to find out. The field on `StorageProvider`
  is an optional `Partial<StorageCapabilities>` and an undeclared capability reads
  as **false**: a fork's custom provider keeps compiling across an upgrade and is
  never assumed capable of something it does not implement. Read it through the
  helper, never off the provider directly.

- **`download(key)` on `StorageProvider`** (#490) — an optional, `Buffer`-based
  read path returning the new `StorageObject`. Implemented by S3 and local;
  Vercel Blob declares it unsupported. The interface could previously write and
  delete an object but never read one back, which is what forced a fork keeping
  a user's uploaded file to discard the original bytes after parsing.

- **`GET /api/v1/storage/<key>?token=…`, the signed object read route** (#490) —
  serves a privately stored object, with stateless HMAC tokens from the new
  `lib/storage/access-tokens.ts` (`generateStorageAccessToken`,
  `verifyStorageAccessToken`, `buildStorageAccessUrl`; no table, no migration).
  `LocalProvider.getSignedUrl()` mints them, which is what completes the local
  provider's private-object story. **The token is the only credential and
  grants exactly one key — there is deliberately no session fallback**, because
  storage keys encode no ownership and a bare `withAuth()` would let any
  authenticated user read any private object. Rotating `BETTER_AUTH_SECRET`
  invalidates every outstanding URL. Responses are always
  `application/octet-stream` + `Content-Disposition: attachment`, so
  user-uploaded HTML or SVG can't execute on the app's origin.

- **A private root for the local provider** (#490) — `LocalProviderConfig.privateDir`
  (default `.storage/private`, gitignored) holds anything uploaded with
  `public: false`, outside the tree Next serves. `createLocalProvider()` now
  takes a config argument and `createLocalProviderFromEnv()` reads
  `STORAGE_LOCAL_BASE_DIR` / `STORAGE_LOCAL_BASE_URL` / `STORAGE_LOCAL_PRIVATE_DIR`
  — the zero-argument factory meant `client.ts` could never configure the
  provider at all.

- **`S3_OBJECTS_PRIVATE_BY_DEFAULT`** (#490) — declares that the bucket blocks
  public access, so every object is already private without ACLs. This is the
  AWS-recommended posture and is invisible at the SDK level; setting it is what
  lets `S3Provider` claim `privateObjects` while leaving `S3_USE_ACL=false`.

- **`assertStoredVectorDimensions(subject)`** in
  `lib/orchestration/knowledge/embedding-dimensions.ts` — the stored-vector
  dimension guard, no longer hard-wired to `aiKnowledgeChunk` (#491). `pgvector`
  fixes dimension at the column level, so changing the active embedding model
  without re-embedding breaks every query against a vector table with a cast
  error, after paying for the embedding round trip. The knowledge corpus was
  guarded; a fork adding its own `vector(...)` table — the documented path,
  since the platform KB is a global asset and per-user scoping there is an
  anti-pattern — inherited the failure with none of the protection, and could
  only get it by copying ~40 lines that would then never learn what the original
  learns. The subject is two closures (`groupByDimension`, `exemplarModel`) plus
  a `label` and a `remediation` string, so it carries no Prisma-delegate typing
  and works for a table that is not a Prisma model at all. `search.ts` now binds
  to it; behaviour and error text are unchanged.

- **`capability.refused_not_advertised` hook event, and `warning` SSE frames on
  a refused tool call** (#488). The handler already refused a tool name outside
  the set advertised to the model for that turn, but said nothing: on the
  single-call path no frame was emitted at all, so the turn carried on and the
  UI showed an answer produced without the data the model asked for, with
  nothing anywhere explaining why. Both refusal paths now yield
  `{ type: 'warning', code }` — `tool_not_advertised` or `tool_unavailable` (the
  repeated-failure breaker) — and the not-advertised case additionally emits the
  new hook event, payload `{ conversationId, agentId, agentSlug, userId,
  toolName, advertised }`. Only the not-advertised case is audited: a name
  outside the advertised set is a hallucination or an injected tool call, which
  is a security signal, whereas the breaker is operational and already logged.
  `advertised` carries the tool set the model actually had, so a reviewer can
  see what it invented the name from.

- **`generatedColumnExists(table, column)`** in `lib/db/drift-probes.ts` — a
  drift probe for a column that must be `GENERATED ALWAYS AS (...) STORED`
  (#481). `columnExists` only asks whether a column of that name is present, so
  a migration that dropped the column and recreated it as a plain one of the
  same type passes the check while the column is never populated again. Probe A1
  (`ai_knowledge_chunk.searchVector`) now uses it. That column backs the BM25
  half of hybrid knowledge search, and the half-missing failure is worse than a
  dropped index: a missing index means slow-but-correct, whereas a column that
  stopped being generated means every row written after the migration holds
  NULL — so search silently returns nothing for new content while old content
  still matches, which reads as an ingestion bug. Forks probing their own
  generated columns should prefer it over `columnExists`.

- **`ChatRequest.openingTurn` — a turn the agent opens** (#474). `streamChat`
  required a non-empty `message` and persisted it as a `role:'user'` row before
  calling the model. Right for a support chatbot; wrong for a facilitated product
  whose method is to orient the person first — the app had to send a stage
  direction *as the user*, leaving text in someone's own transcript that they did
  not write, in the model's history for the rest of the conversation, and
  filterable only by exact string match against a list of every trigger string
  ever shipped. With `openingTurn` set, `message` may be omitted: no user row is
  persisted, no `message.created` fires for a user role, and the content reaches
  the model as a `system` message. `message` wins if both are supplied. A turn
  with no `message`, no `openingTurn` and no attachments is rejected — `message`
  becoming optional made the empty turn expressible, so it is now refused
  explicitly. Attachments count as a turn: the embed surface allows an empty
  `message` when files are attached (a photo with no caption), so gating on
  empty text alone would have rejected vision turns its own route already
  accepted.
  `ChatEvent` `start.messageId` is consequently optional; the shared validator in
  `chat-events.ts` already had it optional, so the TS type was stricter than the
  wire contract, and no bundled consumer reads it off `start`.

- **`ChatRequest.messageMetadata` — caller metadata on the message row** (#475).
  `costLogMetadata` lands on `AiCostLog`; there was nothing for the message
  itself, so an app that caused a turn for its own reasons had nowhere to record
  that fact except inside the message text or an `UPDATE` against a core-owned
  table. Stored verbatim under `MessageMetadata.app`, namespaced so it can never
  collide with a platform field including one a future release adds. The handler
  never inspects it. Together with #474 this replaces sentinel-string detection
  with a structural tag.

- **`lib/app/user-created.ts` — a fork-owned seam at user creation** (#464). A
  fork that needed to react to a new account (provision a profile row, seed a
  workspace, start onboarding, push to a CRM) had to add code to
  `userCreateAfterHook` in `lib/auth/config.ts` — a security-sensitive platform
  file, and a merge conflict on every upstream sync. Register hooks with
  `registerUserCreatedHook(key, hook)`; each receives
  `{ userId, email, name, signupMethod, viaInvitation }`, so it can tell an OAuth
  account (address already verified) from an email/password one. Dispatched last
  in the after-hook, so a hook sees the account fully initialised. A hook
  **cannot reject a signup** — it runs after the row exists, and a throw is
  logged and swallowed rather than reporting a completed signup as an error. To
  gate signup itself, see #463. Empty registry = today's behaviour.

- **`lib/app/jobs.ts` — a fork-owned seam for recurring app work** (#469). The
  scheduler ran workflow schedules only, so an app's own periodic job needed
  either a second cron process and deployment target or an edit to `run-tick.ts`.
  Register with `registerAppJob({ name, intervalMs, run })` and the existing
  maintenance tick runs it when due; the return value is folded into the tick's
  completion log line. Two honest limits, documented on the seam: `intervalMs` is
  a **minimum** gap bounded below by the tick interval (60s), and last-run times
  live in process memory — so a multi-instance deployment runs each job about
  once per instance per interval, and a restart re-arms everything. Write jobs to
  be idempotent; a job needing exactly-once cluster-wide semantics needs its own
  lease. A job still running is never started again (per-job in-flight guard), a
  non-positive `intervalMs` is refused at registration rather than silently
  meaning "every tick", and a rejecting job is contained. Empty registry =
  today's behaviour, byte-for-byte.

- **`NavSection.titleNode` — a fork's own brand lockup in an admin nav section
  header** (#448). Optional `ReactNode` on `registerNavSection({ … })`; when set,
  the sidebar renders it in place of the default uppercase `title` label and
  drops the uppercase treatment. `title` stays required — it remains the React
  key, the registry's dedupe key, and the heading's `aria-label`, so a wordmark
  image cannot degrade the accessible name. Converts a two-file platform edit
  (`lib/admin-nav/registry.ts` + `components/admin/admin-sidebar.tsx`) that
  conflicted on every upstream sync into a supported extension point.

- **`lib/app/csp.ts` — a fork-owned seam for third-party iframe hosts** (#450).
  `frame-src` was hardcoded to `'self'` in both policies, so a fork embedding a
  YouTube or Vimeo player had to edit `lib/security/headers.ts` — a
  security-sensitive platform file, and a recurring merge conflict. Export
  origins from `appFrameSrc` and `getCSPConfig()` folds them into the global CSP.
  Only exact `https://` origins are accepted (left-most wildcard and port
  allowed); anything else is dropped and logged at warn at module load, since
  these values are spliced into a response header. Empty in vanilla Sunrise —
  locked by `tests/unit/lib/app/defaults.test.ts`. See
  [`.context/security/overview.md`](./.context/security/overview.md#third-party-iframes--the-frame-src-seam).

- **`ProcessImageOptions.fit` — an aspect-preserving mode for logos and
  banners** (#447). `processImage()` hardcoded a centre-cropped square, which is
  right for avatars (what it was built for) and wrong for every non-square
  upload. `fit: 'inside'` treats `maxWidth` × `maxHeight` as a real bounding box
  and preserves aspect ratio; `fit: 'cover'` (the default) keeps today's
  behaviour exactly, so no existing caller changes. Both modes remain
  shrink-only. See [`.context/storage/overview.md`](./.context/storage/overview.md).

- **`<RouteErrorBoundary>` — one shared body for every route group's
  `error.tsx`** (#434). New `components/errors/route-error-boundary.tsx` holds
  the logging, Sentry reporting, optional session-expiry detection and recovery
  card that the four `app/**/error.tsx` files each carried a near-identical copy
  of; those files are now thin wrappers. A fork adding a route group writes a
  ~10-line wrapper with its own `boundaryName`, `tag` and `fallback` instead of
  a fifth copy. `fallback.navigate: 'reload'` opts into a full document load for
  boundaries where the shell itself may be broken. `app/global-error.tsx` is
  unchanged — it replaces the root layout and renders its own `<html>`/`<body>`.
  See [`.context/ui/components.md`](./.context/ui/components.md).

- **`slugify(value)`** in `lib/utils.ts` — filename/URL-safe slug. Returns the
  bare slug including the empty string (callers apply their own fallback, e.g.
  `slugify(title) || 'report'`); pure and client-safe, so the same helper works
  in a download button and in a server-side filename. ([#451])

- **`validatePathParam(raw, schema, options?)`** in `lib/api/validation.ts` —
  completes the validation family alongside `validateRequestBody` and
  `validateQueryParams`. Throws the same `ValidationError` that `handleAPIError`
  maps to a 400. Sixteen `[id]` routes drop their hand-rolled copies. ([#435])

- **`CAPABILITY_BINDING_MODE`** env var (`permissive` | `strict`, default
  `permissive` — unchanged behaviour). `strict` makes a missing
  `AiAgentCapability` row DENY instead of synthesizing a default-allow binding.
  Opt-in because it retroactively revokes capabilities agents relied on
  implicitly, including `mcp-system`. ([#476])

- **`DATABASE_POOL_MAX`** — optional cap on pg connections per process, default
  `10` (unchanged behaviour). Serverless deploys set `1` behind a transaction
  pooler; every warm instance holds its own pool, so the default exhausts a
  small Postgres under load. The pool also sets 10s idle and connection
  timeouts, so exhaustion now fails fast instead of hanging until the platform
  kills the request. ([#445])

- **Workflow schedules show their last run time**, alongside the existing next
  run. `AiWorkflowSchedule.lastRunAt` was already on the wire.

[#436]: https://github.com/human-centric-engineering/sunrise/issues/436
[#456]: https://github.com/human-centric-engineering/sunrise/issues/456
[#461]: https://github.com/human-centric-engineering/sunrise/issues/461

- **`framework:*` is now a reserved script namespace, and CI runs
  `framework:ci-checks`** (#483). CUSTOMIZATION.md §7 reserved `app:*` for the
  leaf-fork tier but left a framework-tier fork (one sitting between Sunrise and
  its own forks) with nowhere to put a script — while `scripts/smoke/README.md`
  actively told it to add to Sunrise-owned `smoke:*`. Both are corrected, and
  `scripts/app/` + `scripts/framework/` are now documented as tier-owned
  directories. The `lint` job calls `framework:ci-checks --if-present`, mirroring
  the existing `app:ci-checks` seam, so the reservation is real rather than a
  promise.

### Changed

- **`upload_to_storage` refuses a private-upload binding the provider cannot
  honour** (#490). A binding with `public: false` or `signedUrlTtlSeconds` now
  fails with `private_objects_not_supported` — before any upload — when the
  configured provider does not declare `privateObjects`. **This is a runtime
  break worth planning for:** an agent binding with `signedUrlTtlSeconds` on S3
  with ACLs off previously uploaded a *public* object and returned a signed URL
  to it, which looked like it worked. Set `S3_OBJECTS_PRIVATE_BY_DEFAULT=true`
  (or `S3_USE_ACL=true`) to restore it. `VercelBlobProvider.upload()` likewise
  throws on `public: false` rather than storing the file publicly — that
  provider has no private storage under any configuration.

- **`getOrchestrationSettings()` reads before it writes, and caches for 30s**
  (#442). It was an unconditional `upsert` — a write, taking a row lock, on every
  call, including several per maintenance tick — for a row that is created once
  in the lifetime of an install. It now does a `findUnique` and only upserts when
  the row is absent (still an upsert there, so two instances booting at once
  can't race the unique constraint on `slug`), behind a 30s TTL cache modelled on
  `settings-resolver.ts`. The new `invalidateOrchestrationSettingsCache()` is
  called from the settings PATCH route, so a save is visible immediately.

- **`useHealthCheck` pauses polling while the tab is hidden** (#442). It ran two
  bare `setInterval`s, so a forgotten admin tab issued `GET /api/health` — and
  therefore `SELECT 1` — every 30 seconds indefinitely, enough on its own to keep
  a scale-to-zero database awake. It now runs on `useAutoRefresh`, which already
  pauses on `document.hidden` and handles being hidden at mount. **Two semantic
  shifts for callers:** `isPolling` now means "polling is enabled" rather than "a
  timer is armed", so it stays `true` across a visibility pause; and
  `startPolling()` refreshes immediately instead of waiting out an interval.
  `autoStart: false` still fetches once on mount.

- **Deployment guidance for scale-to-zero databases** (#442).
  `scheduling.md` prescribed `* * * * *` with no note about what that costs on a
  Postgres that autosuspends when idle — a fork following the documented path
  inherited a database that was never allowed to sleep, and a bill to match. The
  recommended cadence is unchanged (the idle gate makes those ticks free), but
  the trade is now stated, with a `*/5` recipe for cutting serverless
  invocations and the price named plainly: a workflow schedule can only be as
  punctual as the cron that drives it. `resilience.md` also now records that
  `tickRunning` is per-instance, so the overlap guarantee does not hold on
  serverless.

- **The maintenance tick can now skip entirely, doing zero database work**
  (#442). Per-task intervals cut how much a tick does; they cannot make it do
  nothing, and nothing is what a scale-to-zero Postgres (Neon, Aurora Serverless
  v2) needs before it will autosuspend — one query a minute defeats a 5-minute
  timer exactly as well as twenty do. A sweep that finds nothing now arms an
  **idle gate**, and subsequent ticks return `200 { skipped: true, reason:
  'idle', resumesAt }` before any Prisma call. Skipping is bounded three ways:
  the gate never skips past known future work (the next `nextRunAt`, via the new
  `getNextScheduleRunAt()`, and the shortest registered app-job interval, via the
  new `getAppJobsMinIntervalMs()`); it re-verifies against the database at least
  every `MAINTENANCE_IDLE_MAX_SKIP_MS` (**new env var**, default 30 min, `0`
  disables the gate); and request paths that create tick-owned work — a delivery
  retry, a created or edited schedule, a queued evaluation run, an execution
  enqueued by a webhook or inbound trigger — call the new `noteMaintenanceWork()`
  to disarm it immediately. It refuses to arm unless the sweep proved there was
  nothing to do: a task that found something, a task that failed, a fired
  schedule, an errored sweep, or a failed horizon probe all leave it disarmed.
  State is per-process, so a restart always sweeps and multi-instance forks
  should lower the cap. **New:** `POST …/maintenance/tick?force=1` sweeps
  regardless (it does not bypass the overlap guard), and the skip response now
  carries `reason` — previously the only skip was the overlap guard and the
  reason string was fixed.

- **Maintenance-tick background tasks now run on per-task minimum intervals**
  (#442). All eight ran on every tick, so at the documented 60s cadence the
  retention sweep — whose windows are measured in days — ran 1,440 times a day
  and the embedding backfill full-scanned the message table just as often. Each
  task now declares the shortest gap at which it can still find work:
  `webhookRetries`, `hookRetries` and `evaluationRuns` stay on every tick
  (sub-minute backoff, one time-slice per tick); `orphanSweep` and
  `pendingExecutionRecovery` 2 min; `zombieReaper` 5 min; `embeddingBackfill`
  15 min; `retention` 1 hour. The table lives in
  `lib/orchestration/maintenance/platform-jobs.ts` and
  `BACKGROUND_TASK_NAMES` is now derived from it, so the route's published
  `backgroundTasks` list cannot drift from what actually runs. **Two visible
  effects:** a task held back by its interval reports the string `'skipped'`
  under its own key in the `Maintenance tick background tasks completed` log
  line (rather than its usual result object), so a log-based dashboard reading
  e.g. `retention.deleted` will see `'skipped'` on most ticks; and a task still
  running from an earlier tick is no longer started a second time when the
  liveness watchdog releases the overlap guard. Intervals are start-to-start and
  held in process memory — persisting them would cost a database round-trip per
  task per tick, which is the cost this change exists to remove. Every throttled
  task is idempotent, so on a multi-instance deployment the failure mode is
  "runs more often than intended", never "misses work".

- **`runStructuredCompletion`'s non-persistence is now contractual** (#472). The
  module writes nothing — no database client imported, no row created, no prompt
  or completion logged — but that was only *incidentally* true. Its docstring
  promised layering neutrality ("no evaluation coupling, no Next.js imports"),
  which says nothing about writes, while a downstream fork's user-facing privacy
  claim (calendar-event titles categorised into aggregate buckets, only the
  totals stored) depended on the stronger property. Adding prompt logging for
  debugging or completion persistence for eval replay would have been consistent
  with everything the file said about itself and would have broken that claim
  without touching the fork's code. The guarantee is now stated explicitly and
  enforced by `structured-completion-no-persistence.test.ts`, which fails on a
  database/storage import or a `prisma.*` call. Cost metadata (token counts, USD)
  is still returned to callers and is outside the guarantee — aggregate counts
  carry no prompt content. Persisting here in future is a breaking change to a
  documented guarantee: opt-in flag defaulting to off, CHANGELOG entry, and a
  deliberate test update rather than a deletion.

- **BREAKING: `HookEventType` is open to fork-owned events** (#465).
  `HOOK_EVENT_TYPES` was a closed list, so a fork could neither emit its own
  domain event through the hook registry nor subscribe a webhook to one — it had
  to add entries to a platform array, conflicting on every sync and risking a
  collision with a name a future release takes. `HookEventType` is now
  `CoreHookEventType | \`app.${string}\` | \`framework.${string}\``, matching
  the reserved tiers in CUSTOMIZATION.md, and the admin hook routes accept the
  wider set so a fork can subscribe through the same API. **Forks:** an
  exhaustive `switch` over `HookEventType` with an `assertNever` default now
  fails to compile. That is the intended failure — a compile-time prompt to
  decide what your code does with an event it doesn't know, instead of a silent
  runtime fall-through. The core enum is kept as one arm of the Zod union rather
  than replaced with `z.string()`, because that schema also validates
  `AiEventHookDelivery.payload` read back from the database.
  A namespaced union rather than a registration seam, deliberately: these schemas
  are built at module load, before any `initApp()` runs, and #462 showed boot
  order across module realms isn't guaranteed under Turbopack.
  `WEBHOOK_EVENT_TYPES` stays **closed** and is now documented as such — a hook's
  only action type *is* a webhook, so the hook registry already gives a fork the
  whole path, and those values are rendered straight into `<select>` options and
  cross-referenced against `WIRED_WEBHOOK_EVENT_TYPES`, where a fork-namespaced
  value would have no label and no wired-ness answer.

- **A fork can now ADD an email kind, not just override one** (#468).
  `EmailPropsMap` is an `interface`, so declaration merging already worked in
  principle — but `defaultTemplates` was a total mapped type over `EmailKind`,
  which made every fork-added kind a compile error in a platform file the fork
  can't edit without a conflict. It is now `Partial`, and `resolveEmailTemplate`
  throws naming the kind when there is neither an override nor a default. Throwing
  rather than rendering `undefined` is deliberate: a blank email is far harder to
  diagnose than a failed send. The interface now documents the `declare module`
  recipe and recommends namespacing keys `app.` / `framework.`. No runtime change
  for the four platform kinds.

- **`prisma/schema/app.prisma` is now genuinely fork-reserved and ships empty**
  (#429). It shipped three platform models — `ContactSubmission`, `FeatureFlag`,
  `AuthBootstrap` — while the fork-facing docs described it as the place for a
  fork's own models, "clearly separate from the platform's". The three model
  definitions move verbatim into the existing `prisma/schema/platform.prisma`.
  Because the schema is multi-file, moving a model block between files changes
  no table and produces **no migration** — the models, their `@@map` names, and
  the generated client are unchanged. This makes the leaf tier symmetric with
  the framework tier's `prisma/schema/framework-*.prisma`. Forks that already
  added models to `app.prisma` need no action.

- **Error-boundary log message is now `'Route error boundary triggered'` for all
  four route groups** (#434), replacing the four per-group messages
  (`'Root error boundary triggered'`, `'Admin route error boundary triggered'`,
  …). The boundary is still identified by the structured `boundaryName` field,
  which is what log queries should key on. `app/global-error.tsx` keeps its own
  `'Global error boundary triggered'` message.

- **CI heap ceiling is now the `CI_NODE_HEAP_MB` repo variable** (default
  `5120`, unchanged). Forks whose lint job dies with exit 134 raise it in repo
  settings instead of editing `ci.yml`, so the fix survives an upstream sync.
  ([#452])

- **`tests/unit/lib/app/defaults.test.ts` is table-driven.** Filling a
  `lib/app/*` seam is expected to fail one row; pin the new value rather than
  deleting the row. Coverage also rose from 9 seams to 14. ([#480])

- **Vitest `testTimeout` raised to 30s** (from 10s) for forks with heavier
  component and integration tests. ([#454])

- **`streamChat` batches its three pre-token reads** (context, user memories,
  capability definitions) into one `Promise.all`, cutting the delay before the
  first token from three serial database round trips to one. No behavioural
  change. ([#449])

[#444]: https://github.com/human-centric-engineering/sunrise/issues/444
[#445]: https://github.com/human-centric-engineering/sunrise/issues/445
[#446]: https://github.com/human-centric-engineering/sunrise/issues/446
[#449]: https://github.com/human-centric-engineering/sunrise/issues/449

- **`CostSummaryModelRow` carries `provider`.** `GET /costs/summary`'s `byModel[]`
  rows are now `{ model, provider, monthSpend }`, grouped by both columns of
  `AiCostLog`. Consumers resolving a spend row to a catalogue entry must key on
  `provider::modelId` — `components/admin/orchestration/costs/model-index.ts`
  (`buildModelIndex` / `lookupModel`) is the shared helper. ([#436])

- **The Azure `gpt-4o` seed row ships inactive.** It shares a model id with the
  OpenAI row; an unconfigured example provider shouldn't compete for that id.
  Applied on create only, so a re-seed never deactivates a row an operator
  turned on. ([#436])

### Fixed

- **`upload(file, { public: false })` is no longer silently ignored** (#490). The
  option was accepted by every provider and honoured by roughly one: S3 dropped
  it unless `S3_USE_ACL=true`, Vercel Blob dropped it always, and the local
  provider wrote the file into `public/uploads/` where Next serves it statically
  to anyone who can guess the key. A fork storing a user's document rather than a
  public avatar got private storage, a public CDN URL, or a world-readable file
  with no way to tell which apart from sniffing `provider.name`. Each provider
  now declares what it can do, S3 warns once per process when it cannot enforce
  the request, and Vercel Blob refuses outright.

- **Local storage deletes now sweep the private root as well as the public one**
  (#490). `delete()` and `deletePrefix()` only ever touched `baseDir`. With the
  private root added, that would have made `eraseUser()` — which clears a user's
  blobs via `deleteByPrefix('avatars/<userId>/')` — a partial delete, leaving
  private files on disk after erasure. Both roots are swept, and a failure in
  either is reported rather than masked by the other's success.

- **The retention sweep reads the settings row once instead of eight times**
  (#442). `resolveRetentionDays()` fetched the same singleton row per prune, so
  one sweep spent eight round-trips retrieving six columns — 1,440 times a day at
  the documented tick cadence, and all of it wasted on a default install where
  every window is `null` and every prune no-ops. `enforceRetentionPolicies()` now
  calls the new `loadRetentionWindows()` once and passes each window down. The
  individual `pruneX()` functions are unchanged for direct callers, but their
  first parameter widens to `number | null | undefined`: `undefined` still means
  "resolve it yourself", an explicit `null` now means "skip". The coherence
  warning reads from the same loaded windows rather than issuing its own query.

- **The MCP config cache no longer collides with the maintenance-tick interval**
  (#442). `CACHE_TTL_MS` was 60s — exactly the tick cadence — so the retention
  sweep's `getMcpServerConfig()` call was a coin-flip between a hit and a miss,
  and the miss path is an `upsert`, i.e. a write taking a row lock, roughly every
  other tick. Raised to 5 minutes; invalidation on admin mutation was already
  explicit, so nothing goes stale that wasn't already.

- **The embedding backfill's anti-join has an index to use** (#442). It filters
  `AiMessage` on `role` and orders by `createdAt`, but the table was indexed on
  `role` alone, so proving the backlog empty meant a scan plus a sort that grew
  with the table — every tick, forever. Adds `@@index([role, createdAt])` and
  drops the now leading-column-redundant `@@index([role])`. **Migration:**
  `20260730140000_add_message_role_createdat_index`.

- **Tab titles and legal-page metadata now route through the `BRAND` seam**
  (#432). `SETTINGS_TAB_TITLES` and `KNOWLEDGE_TAB_TITLES` hardcoded `"Sunrise"`,
  and `useUrlTabs` writes them straight to `document.title` — so a fork with
  `NEXT_PUBLIC_APP_NAME` set still showed "Sunrise" in the browser tab on
  `/settings` and the admin knowledge base, overriding correct layout metadata.
  The static metadata on `app/(public)/{privacy,terms,contact}` had the same
  hardcode. All now interpolate `BRAND.name`. `about/` is deliberately left
  alone — its copy describes the template itself and is fork-replaced body copy.

- **The protected error boundary's "Session Expired" card now actually renders
  when a session expires.** The session check tested `authClient.getSession()`
  for truthiness, but better-auth always resolves that call to a
  `{ data, error }` envelope — never `null` — so the condition never fired and
  the sign-in prompt only appeared when the request itself threw. The check now
  destructures `{ data: session }`, matching the other call sites in the repo.
  Pre-existing on `main` (`app/(protected)/error.tsx`), carried into the shared
  boundary by this release's refactor and fixed there.

- **Route-group error boundaries no longer double-log and double-report on
  session expiry** (#433). The logging effect included `isSessionExpired` in its
  dependency array while also setting it, so a session-expiry error re-ran the
  effect and produced two `logger.error` lines and two Sentry events. The shared
  boundary reports once per error (deps `[error]`) and drops `isSessionExpired`
  from the Sentry `extra` — it was always `false` at report time anyway.

- **`next/font/google` and `next/font/local` now resolve under Vitest.** Font
  loaders run at module scope, so a fork adding brand typography previously saw
  every test importing that layout fail at import time. Loader names are derived
  from Next's own declarations, so no fork edits a platform test file. ([#455])

- **Secret scanning keeps `--results=verified,unknown`** and ships a
  fixture/docs path allowlist instead, so forks do not have to trade away the
  unverifiable-secret class to stop false positives on example DSNs. ([#453])

[#435]: https://github.com/human-centric-engineering/sunrise/issues/435
[#451]: https://github.com/human-centric-engineering/sunrise/issues/451
[#452]: https://github.com/human-centric-engineering/sunrise/issues/452
[#453]: https://github.com/human-centric-engineering/sunrise/issues/453
[#454]: https://github.com/human-centric-engineering/sunrise/issues/454
[#455]: https://github.com/human-centric-engineering/sunrise/issues/455
[#480]: https://github.com/human-centric-engineering/sunrise/issues/480

- **MCP tool dispatch warms the capability registry.** A process that had only
  served MCP — no chat or workflow request yet — had an empty in-memory
  registry, so every MCP tool call failed with `Unknown capability`, built-ins
  included, while `tools/list` still listed them. ([#457])

- **Boot-registered context contributors and capability handlers survive to
  request time.** Both registries are now backed by `globalThis`, as the Prisma
  client already was. Under Next 16 + Turbopack `instrumentation.ts` runs in a
  separate module graph from route handlers, so a framework tier registering at
  boot silently vanished on the request path. ([#462])

[#437]: https://github.com/human-centric-engineering/sunrise/issues/437
[#457]: https://github.com/human-centric-engineering/sunrise/issues/457
[#462]: https://github.com/human-centric-engineering/sunrise/issues/462
[#466]: https://github.com/human-centric-engineering/sunrise/issues/466
[#476]: https://github.com/human-centric-engineering/sunrise/issues/476
[#489]: https://github.com/human-centric-engineering/sunrise/issues/489
[#502]: https://github.com/human-centric-engineering/sunrise/issues/502

- **`LlmOptions.timeoutMs` and `signal` reach the provider SDKs.** Both were
  documented but dropped, so a call that needed longer than the client default
  died at the default with no indication the option had been ignored. All four
  adapter paths (`chat` and `chatStream` on Anthropic and OpenAI-compatible)
  now forward them; setting neither leaves the provider default in charge.
  ([#444])

- **PDF parsing survives serverless file tracing.** The pdfjs worker is
  registered on `globalThis` from a literal import specifier, so it ships in the
  function bundle — previously every PDF upload on Vercel failed with "Setting
  up fake worker failed", while working locally. ([#446])

- **`chatStreamEventSchema` models `budget_exceeded_per_turn`.** The variant was
  missing, so `parseChatStreamEvent` returned null and consumers dropped the
  frame — and on the tool-loop-abort path it is the last frame sent, leaving an
  empty assistant turn with no explanation. ([#461])

- **Per-model cost rows no longer borrow another provider's label.** Spend served
  by OpenAI's `gpt-4o` could render as `microsoft` / "GPT-4o (Azure)". ([#436])

- **`costLogRetentionDays` below `executionRetentionDays` is rejected** at all
  three write paths (settings form, Zod schema, PATCH route against the persisted
  row). Cost logs must outlive the executions that reference them or the
  drill-down empties out under a retained execution. Installs already in that
  state get a warning per retention sweep. ([#456])

- **`prisma/schema/orchestration-agents.prisma` is formatted per the pinned
  Prisma, and CI now enforces it** (#482). `model AiAgent`'s attribute column was
  one short of what `prisma format` produces, so every fork's first `prisma format`
  dirtied a core file it never edited. Prettier doesn't touch `.prisma`, so
  `format:check` couldn't see the drift; the `lint` job now runs `prisma format`
  and fails on a non-empty diff. Whitespace only — no schema or client change.

## [0.7.0] — 2026-07-09

> **Alpha release.** Ninth tagged Sunrise release. **MINOR bump** — adds new
> public surface: seven fork-facing seams and primitives requested by Daybreak
> under the fork-first pattern, all additive and inert in vanilla Sunrise until
> a fork opts in. Two chat guard seams — **`registerGuardFloorContributor`**
> (raise an inline input/output/citation guard to a per-turn minimum; raise-only)
> and its post-detection sibling **`registerGuardEventContributor`**
> (fire-and-forget observation of a guard firing). Context + conversation —
> **per-user `buildContext`** (`ContextRequest { userId? }` threaded to
> contributors + a user-partitioned cache) and **`findResumableConversation`**
> (resume a surface's conversation by its `(contextType, contextId)` tuple).
> Capability + chat carriers — **`CapabilityContext.customConfig` + `isEnabled`**
> surfaced from the resolved binding, and a bounded **consumer chat `scope` map**
> on the public route. Plus **`runStructuredCompletion` relocated** to a neutral
> `lib/orchestration/llm/` home with an open `phase` tag. No breaking changes.

### Added

- **Chat guard-event seam — a fork can OBSERVE an inline guard firing
  (post-detection) and react** (#414). New `registerGuardEventContributor(key,
  contributor)` (exported from `@/lib/orchestration/chat`, with types
  `GuardEventContext` / `GuardEvent` / `GuardEventContributor`). When an inline
  guard (input / output / citation) flags, the handler calls `emitGuardEvent`
  **fire-and-forget** to contributors keyed on the turn's `(contextType,
  contextId, agentId, userId, conversationId)` with `{ guard, outcome }`, so a
  fork can notify / log / escalate without editing the guard sites. Fire-and-forget
  — it never delays or breaks the turn (contributors run on a microtask; a
  throwing/rejecting contributor is swallowed), it fires before the `block`
  short-circuit so a block is still observed, and an empty registry is inert.
  Observation only — it cannot change detection or the guard's action (use the
  guard-floor seam for that). Fork-owned scaffold
  `lib/app/guard-event-contributors.ts`. The post-detection sibling of the
  guard-floor seam (#413).
- **Chat guard-floor seam — a fork can RAISE an inline guard to a minimum for a
  turn** (#413). New `registerGuardFloorContributor(key, contributor)` (exported
  from `@/lib/orchestration/chat`, with types `GuardKind` / `GuardMode` /
  `GuardFloors` / `GuardFloorRequest` / `GuardFloorContributor`). A contributor
  keyed on the turn's `(contextType, contextId, agentId)` returns a per-guard
  **minimum** mode for the three inline guards (input / output / citation), and
  the handler raises each guard to the strictest registered floor. **A floor
  only ever RAISES a guard, never lowers it** (`none` < `log_only` <
  `warn_and_continue` < `block`); an empty registry leaves guard-mode resolution
  byte-for-byte unchanged, and a throwing contributor is skipped. Fork-owned
  scaffold `lib/app/guard-floor-contributors.ts` (`initAppGuardFloorContributors()`).
- **`CapabilityContext` now carries the resolved binding's `customConfig` +
  `isEnabled`** (#411). The dispatcher populates `context.customConfig`
  (`AiAgentCapability.customConfig`, normalised to an object or `null`) and
  `context.isEnabled` from the per-agent binding it already resolves at step 4,
  so a capability can read its own per-binding config inside `execute()` without
  re-querying `AiAgentCapability`. Both are set on a shallow copy (the caller's
  context object is untouched) and stay opaque carriers alongside `scope` — core
  sets `customConfig` but reads no keys, so consumers must still validate it
  (e.g. Zod). `AgentCapabilityBinding` gains a matching `customConfig` field.
  Inert for existing capabilities (they may adopt it to drop their own lookup);
  no behaviour change.
- **Consumer chat request accepts an opaque `scope` map** (#415).
  `consumerChatRequestSchema` (`POST /api/v1/chat/stream`) now takes an optional
  `scope: Record<string, string>`, threaded verbatim into every capability
  dispatch for the turn as `CapabilityContext.scope` — the same carrier the
  internal chat handler already threads. Inert in vanilla Sunrise (no built-in
  reads it); a fork can surface-scope a consumer conversation without shadowing
  the route. Because it arrives on an untrusted end-user request it is bounded
  (≤ 32 entries, keys ≤ 100 chars, values ≤ 500 chars), and a fork reading it
  for access decisions must re-validate against the user's entitlements — a
  consumer-supplied scope is a hint, not an authorization grant.
- **`findResumableConversation` — resume a surface's conversation by its context
  tuple** (#416). New helper (exported from `@/lib/orchestration/chat`, with type
  `ResumableConversationQuery`) that resolves a user's most-recent-active
  conversation for a `(userId, agentId, contextType, contextId)` surface, ordered
  by `updatedAt` desc, or `null` if none. Core already **binds** that tuple onto a
  conversation at creation and **injects** entity context for it (`buildContext`)
  but had no resume-by-tuple path — a "surface" (a stable place a user returns to)
  had to re-derive the query. The lookup is always scoped to `userId` + `agentId`
  + `isActive`, so centralising it also removes the risk a hand-rolled copy omits
  `userId` (a cross-user leak). Deciding *when* to resume stays the caller's job
  (the handler never resumes by tuple on its own); the existing
  `@@index([contextType, contextId])` supports it — no migration. Inert in vanilla
  Sunrise (no core surface calls it).

### Changed

- **Context builder threads per-request `userId` + partitions its cache by
  user** (#412). `buildContext` and `invalidateContext` take an optional third
  argument — a generic `ContextRequest { userId? }` (new exported type) — passed
  through to each `ContextContributor` (its loader signature widens to
  `(id, request) => Promise<string>`), and the 60 s result cache now keys on
  `(type, id, userId)` instead of `(type, id)`. Lets a fork return **per-user**
  prompt context without risking a cross-user cache leak. An empty/absent
  `userId` collapses to a single shared partition — byte-for-byte the previous
  behaviour — and a loader that ignores the new arg (`(id) => …`) stays valid.
  The streaming handler passes the turn's `userId` at all three call sites.
- **LLM structured-completion runner relocated to a neutral home** (#410). Moved
  `runStructuredCompletion` (with `StructuredCompletionOptions` /
  `StructuredCompletionResult`) out of
  `lib/orchestration/evaluations/parse-structured.ts` into
  `lib/orchestration/llm/structured-completion.ts` — it is a general LLM utility
  with no evaluation coupling, so a non-evaluation caller no longer imports
  through an eval-shaped path. The `phase` option widens from the closed
  `'summary' | 'scoring'` union to an open `string`, letting a caller tag its own
  span/cost phase (e.g. `'slot-extraction'`). No behaviour change: the OTEL
  attributes (`gen_ai.operation.name`, `sunrise.evaluation.phase`) and the
  omitted-`phase` default (`'evaluation'`) are unchanged. The `tryParseJson` /
  `stripCodeFence` JSON parse helpers remain in `parse-structured.ts` (every
  caller is an evaluation grader).

## [0.6.0] — 2026-07-06

> **Alpha release.** Eighth tagged Sunrise release. **MINOR bump** — adds new
> public surface, all fork-facing seams that stay inert in vanilla Sunrise: the
> capability `register()` **slug override + pre-execute `guard`**
> (`CapabilityRegisterOptions` / `CapabilityGuard` / `CapabilityGuardDecision`;
> guard runs as dispatch step 4a, fail-closed), the **knowledge
> access-contributor** seam (`registerAgentAccessContributor` — a fork widens a
> restricted agent's document set live), the reserved **`/framework` namespace
> tier** + generic `initApp()` boot seam (`lib/app/bootstrap.ts`), the fork-owned
> **ESLint config + `app:ci-checks`** seams, MCP **`tools/list` agent scoping**
> (with the `callMcpTool()` caller-object signature change), and
> `send_notification` **`to` interpolation**. Plus fixes: workflow
> `{{trigger.*}}` template resolution, the admin MCP key-hash audit leak
> (Security), and spurious `updatedAt` audit-diff noise across nine admin routes.
> Both new dispatcher/knowledge seams are byte-for-byte inert until a fork opts
> in.

### Security

- **Admin MCP API-key audit no longer records the key hash.** The
  `PATCH /api/v1/admin/orchestration/mcp/keys/:id` handler diffed a full-row
  `existing` against a narrower `select`-ed `updated`, so `computeChanges`
  recorded every column present only on `existing` — including `keyHash` (the
  SHA-256 of the key), which `SECRET_PATTERN` did not redact — as a spurious
  `→ undefined` change on **every** PATCH, writing the hash into
  `AiAdminAuditLog.changes`. Both rows are now fetched through the same
  projection (which omits `keyHash`/`scopedAgentId`/`createdBy`), and
  `SECRET_PATTERN` additionally redacts `key`/`token` digest fields (`keyHash`,
  `tokenHash`) as defense in depth — without over-redacting non-secret digests
  like `fileHash`/`contentHash`. The hash is not the key and the log is
  admin-only, so impact is low — but a credential-derived value no longer sits
  in the audit table. (#388)

### Added

- **Capability `register` options — `slug` override + pre-execute `guard`.**
  `capabilityDispatcher.register(capability, options?)` and
  `registerAppCapability(capability, options?)` now accept an optional
  `{ slug?, guard? }` (new exported types `CapabilityRegisterOptions`,
  `CapabilityGuard`, `CapabilityGuardDecision`). `slug` overrides the in-memory
  handler key so a fork can mount one capability class under a namespaced slug;
  `guard` is an async-capable predicate run as dispatch **step 4a** (after the
  per-agent binding, before the rate limiter) that reads the generic
  `CapabilityContext.scope` and returns `{ allow, reason? }` — `{ allow: false }`
  (or a throw) denies with the new `capability_guard_denied` code, failing
  **closed**. Together they let a fork mount and scope-gate a capability
  **without wrapping it** — a wrapper would have defeated `register()`'s
  PII-redaction own-property check, so both options keep that guard inspecting
  the real subclass. Hard contract: an override `slug` must map to an **active
  `AiCapability` row** or dispatch dies at `capability_inactive` before the
  handler/guard runs. Both fields are opt-in; core attaches no guards and uses
  no slug overrides, so vanilla behaviour is byte-for-byte unchanged. (#398)
- **`lib/app/knowledge-access-contributors.ts` — fork-owned knowledge
  access-contributor seam.** A new `lib/app/**` seam mirroring
  `registerContextContributor`: a fork registers
  `registerAgentAccessContributor(key, (agentId) => Promise<{ documentIds?, tagIds? }>)`
  to **widen a restricted agent's searchable document set** from a relationship
  it owns (module membership, team ACL, per-tenant grant), composed **live** by
  `resolveAgentDocumentAccess()` instead of materialising derived grants onto the
  per-agent pivot (which has no provenance column, making copy-down
  clobber-or-leak). Contributors run only in the `restricted` branch (a `full`
  agent is never touched) and can only **widen**; contributed `tagIds` expand to
  their documents like a tag grant; a contributor that throws is logged and
  ignored; an empty registry is byte-for-byte the previous behaviour. When the
  data a contributor reads changes, the subsystem calls the existing
  `invalidateAgentAccess(agentId)`. (#403)
- **`lib/app/eslint.config.mjs` + `app:ci-checks` — fork-owned ESLint & CI
  seams.** A fork can now add its own ESLint import-boundary rules and CI checks
  without editing platform-owned files (which would conflict on every
  `git merge vX.Y.Z`). The root `eslint.config.mjs` imports and spreads the
  reserved `lib/app/eslint.config.mjs` (ships `export default []`) as its **last**
  argument, so fork blocks land after core and win for their own `files`; the
  seam header documents the load-bearing spread order and the flat-config
  `no-restricted-imports` **replace-not-merge** footgun (restate the `@/`-alias
  ban per glob). The CI `lint` job runs `npm run app:ci-checks --if-present`, so
  a fork adds an `app:ci-checks` script to `package.json` with **no `ci.yml`
  edit** (no-op in vanilla Sunrise). Both default to inert. (#382)
- **`lib/app/bootstrap.ts` — fork-owned server boot seam (`initApp`).** A new
  `lib/app/**` seam: `instrumentation.ts` `register()` calls the reserved,
  empty-by-default `initApp()` once per server process for one-time startup work
  (warm a cache, start a worker, boot a framework tier). It runs in **every**
  environment (placed above the dev-only maintenance-ticker guards) and is
  isolated in a try/catch, so a fork's boot failure is logged but never crashes
  instrumentation or stops the dev ticker arming. Core imports only
  `@/lib/app/bootstrap`; a fork imports its own tier **dynamically** from there
  (a static `@/lib/framework` specifier breaks `next build` in vanilla Sunrise).
  Also **reserves a second fork-namespace tier, `/framework`**, for
  framework-layer forks that sit between Sunrise and their own leaf forks
  (`lib/framework/`, `.context/framework/`, `prisma/schema/framework-*.prisma`,
  the `framework_` table prefix) — Sunrise core never creates files or tables
  there, generalising #371's `/app` (leaf) reservation to two tiers. Default
  (empty `initApp`) is unchanged behaviour. (#385)
- **`lib/app/protected-routes.ts` — fork-owned protected-route registry.** A new
  `lib/app/**` seam: a fork lists extra authenticated route prefixes in
  `appProtectedRoutes` (ships empty) and the proxy **merges** them with the core
  prefixes (`/dashboard`, `/settings`, `/profile`) for the edge redirect-to-login,
  instead of editing the `proxy.ts` literal. Append semantics (core prefixes always
  stay protected); malformed entries not starting with `/` (e.g. an empty string
  that would match every path) are dropped. This is only the "is-logged-in-at-all"
  edge gate — per-resource authorisation stays in the `withAuth`/`withAdminAuth`
  guards. Default (empty list) is unchanged behaviour.
- **Payload-derived inbound scope — `NormalisedTriggerPayload.scope`.** An inbound
  adapter's `normalise()` may now return an optional `scope` (a flat string→string
  map) computed from the verified request body, letting an event-triggered run be
  scoped by what the caller sent (e.g. a fork's GitHub adapter mapping a
  `pull_request` repo to `{ projectId }`). The inbound route runs the
  adapter-returned value through the shared `resolvePersistedScope` validate-on-read
  guard (adapters aren't trusted to return well-formed data — malformed drops to
  unscoped) and shallow-merges it **under** the static `AiWorkflowTrigger.scope`,
  so the operator's config wins on key conflicts. Core's built-in adapters leave it undefined; derivation is
  fork-specific. Completes the `CapabilityContext.scope` trigger-entry population
  (the static half shipped alongside).
- **`AiWorkflowSchedule.scope` + `AiWorkflowTrigger.scope` (nullable JSON) —
  trigger-entry scope population.** Scheduled and inbound-triggered workflow runs
  can now carry a static application-level `scope` (a flat string→string map),
  stamped onto the created `AiWorkflowExecution.scope` so capabilities inside the
  run enforce it. A schedule/trigger's `scope` is settable as opaque JSON via the
  admin schedule/trigger create + PATCH endpoints (clearing uses the
  `Prisma.DbNull` sentinel); the admin `POST /workflows/:id/execute` +
  `execute-stream` routes accept an optional `scope` for a manual run. Persisted
  values are validated on read via a new shared helper `resolvePersistedScope`
  (`lib/orchestration/scope.ts`) — a malformed row is dropped to unscoped (never
  wedges a run) — which also now backs the engine resume path. The generic
  webhook trigger is deliberately left unscoped: scoped event triggers use the
  inbound-adapter seam. Core names no keys; `NULL`/unset is unchanged behaviour.
  The second populator of the `CapabilityContext.scope` carrier (after the MCP
  key); payload-derived (dynamic) scope for inbound adapters is tracked
  separately.
- **`McpApiKey.scope` (nullable JSON) — per-key scope population.** An MCP API
  key may now carry an optional application-level `scope` (a flat string→string
  map, distinct from the coarse protocol `scopes` array). It is validated on read
  (`mcpKeyScopeSchema`) and folded into `CapabilityContext.scope` for every
  `tools/call` made with the key (the dormant `callMcpTool` param from the MCP
  `tools/call` work is now populated), so an external MCP caller's tool calls are
  automatically scoped without passing scope on each call. Settable as opaque JSON
  via the admin key create/PATCH endpoints (clearing uses the `Prisma.DbNull`
  sentinel); a malformed stored value is dropped at auth (key treated as unscoped)
  rather than failing authentication. Core names no keys; `NULL`/unset is
  unchanged behaviour. First populator of the `CapabilityContext.scope` carrier;
  workflow trigger entry points are tracked separately.
- **`AiWorkflowExecution.scope` (nullable JSON) + workflow `tool_call` scope
  threading.** Completes the `CapabilityContext.scope` seam (0.5.0) on the
  workflow path. A run started via `OrchestrationEngine.execute` may now carry
  an optional `scope` (`ExecuteOptions.scope`); it is persisted on the execution
  row so it survives crash-resume (the resume path reads it back, validated by
  `workflowScopeSchema`, and rethreads it into the rebuilt `ExecutionContext`),
  and every capability dispatch forwards it — the `tool_call` executor and the
  `agent_call` tool-use loop (so `orchestrator` delegations are scoped too).
  Core names
  no keys and no built-in capability reads it; `NULL`/unset leaves behaviour
  unchanged. With the MCP `tools/call` path (above), `scope` now reaches
  capability `execute()` on all three dispatch paths (chat, MCP, workflow).
  The execution **rerun** endpoint inherits the original run's `scope`
  (alongside its inputData / budget / version), and the `run_workflow`
  capability inherits the parent run's `scope` into a sub-workflow — so
  a capability at any workflow depth sees the run's scope.

### Changed

- **MCP `tools/list` is scoped to the key's agent (list/call parity).** When an
  MCP API key is bound to an agent (`scopedAgentId`), `tools/list` now hides
  capabilities **explicitly disabled** for that agent (an `AiAgentCapability`
  row with `isEnabled = false`) — so a scoped key can no longer *discover* a
  tool it would then be refused on *call* (since #380, `tools/call` dispatches
  under the scoped agent). Scoping stays **default-allow**: capabilities with no
  binding row remain listed and callable; only explicit disables are honoured.
  Unscoped keys see the full global list, unchanged. The shared
  `capability_disabled_for_agent` dispatcher error message no longer embeds the
  internal agent cuid (it's surfaced verbatim to MCP clients); the id stays in
  server logs only. (#381)
- **`send_notification` step interpolates the `to` recipient.** The email
  recipient(s) are now run through the same `{{…}}` interpolation as `subject`
  and `bodyTemplate`, and the **resolved** value is validated as an email at
  runtime (a template resolving to a non-email fails the step non-retriably with
  `INVALID_RECIPIENT`). A literal `to` is still validated as an email when the
  step config is parsed at execution start (`INVALID_CONFIG` on a mistyped
  literal) and behaves identically. This lets a per-user scheduled workflow
  template the recipient (`to: '{{input.userEmail}}'`) with the built-in step
  instead of a bespoke `sendEmail` capability. The exported
  `sendNotificationConfigSchema` relaxes `to` accordingly: a plain string with no
  template token is still validated as an email; a `{{…}}` template is accepted
  and validated on resolution.
- **`callMcpTool()` signature** — the third parameter changed from
  `userId: string | null` to a caller object
  `{ userId: string | null; scopedAgentId?: string | null; scope?: Record<string, string> }`.
  This lets an MCP tool call run under the API key's scoped agent and carry the
  optional per-dispatch `scope` carrier (`CapabilityContext.scope`, added in
  0.5.0) through to `execute()`. Direct callers passing a bare `userId` must
  wrap it as `{ userId }`.

### Fixed

- **Workflow template namespace `{{trigger.*}}` did not resolve.** The engine's
  `interpolatePrompt` had no `trigger.` branch, so a documented, widely-used token
  like `{{trigger.conversationId}}` / `{{trigger.text}}` (the default config for
  inbound-triggered `chat_turn` steps, and what the step's own error messages tell
  you to use) silently expanded to the empty string — an inbound-triggered
  `chat_turn` would fail with `missing_conversation_id` / `missing_message` on
  every real run. `{{trigger.<dotted.path>}}` now reads an inbound run's data —
  the verified adapter payload (`inputData.trigger`) with a fallback to the
  resolved envelope (`inputData.triggerMeta`), so `{{trigger.text}}` reads the
  payload and `{{trigger.conversationId}}` the envelope where the resolved id
  actually lives. It also works inside `{{#if …}}` conditionals. The bug was
  masked because the `chat_turn` unit + inbound integration suites **mocked**
  `interpolatePrompt` with a stub that faked `trigger.` support (and fabricated a
  `trigger.conversationId` shape production never emits); both now exercise the
  real interpolator against the real inbound shape. Also corrected the workflow-builder editors'
  help text (`{{steps.<stepId>.output}}` → `{{<stepId>.output}}`; there is no
  `steps.` prefix) and stopped the builder's `send_notification` check from
  false-flagging a valid array-shaped `to` as "needs recipients".
- **MCP `tools/call` ignored the API key's `scopedAgentId`.** Tool calls always
  ran under the shared `mcp-system` agent, so cost/budget attribution and
  knowledge-base grant resolution (`resolveAgentDocumentAccess`) did not honour a
  scoped key — inconsistent with the `resources/read` path, which already
  resolved via `scopedAgentId`. `tools/call` now resolves the executing agent
  from the key's `scopedAgentId` when set, falling back to `mcp-system` for
  unscoped keys (unchanged behaviour for keys with no scoped agent).
- **Admin config-update audit diffs no longer record a spurious `updatedAt`
  change.** Nine admin orchestration PATCH routes (`settings`, `mcp/settings`,
  `triggers/:id`, `providers/:id`, `workflows/:id`, `knowledge/tags/:id`,
  `hooks/:id`, `webhooks/:id`, `agent-profiles/:id`) diffed the pre-update row
  against the post-update row without ignoring Prisma's `@updatedAt` column,
  which bumps on every `update()` — so `AiAdminAuditLog.changes` recorded a
  timestamp `from`/`to` on **every** edit, drowning the real field changes. All
  nine now pass `ignoreKeys: ['updatedAt', 'createdAt']` to `computeChanges`,
  matching the `agents/:id` route that already did. Signal-quality only — no data
  exposure. (#396)

## [0.5.0] — 2026-07-01

> **Alpha release.** Seventh tagged Sunrise release. **MINOR bump** — adds new
> public surface: two generic core seams a downstream framework layer needs, both
> inert in vanilla Sunrise. The per-dispatch **scope carrier**
> (`CapabilityContext.scope`, threaded verbatim from a new `ChatRequest.scope`;
> core names no keys and no built-in capability reads it) lets a consumer make a
> capability refuse to run outside its intended scope. The **context-contributor
> registry** (`registerContextContributor()` + the fork-owned empty scaffold
> `lib/app/context-contributors.ts` → `initAppContextContributors()`, a new named
> seam in [`VERSIONING.md`](./VERSIONING.md#covered)) lets a fork inject its own
> `LOCKED CONTEXT` block per turn without editing the core `buildContext` switch —
> with fork loader and one-time-init errors caught so they never fail a chat turn.
> Both were added so a fork can attach per-dispatch scope and pluggable
> prompt-context loaders without patching platform code. Ships in `0.x` per
> [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) — forks
> adopting this release should expect real merge work between any two `0.x`
> releases.

### Added

- **`CapabilityContext.scope?: Record<string, string>`** — an optional, free-form
  scope map the dispatcher's caller can populate; the dispatcher threads it
  verbatim into `execute()`. Generic by design: core names no keys and no
  built-in capability reads it. The chat handler threads it from a new
  `ChatRequest.scope`. Lets a downstream consumer make a capability refuse to run
  outside its intended scope. Inert (`undefined`) when unused. (#372)
- **`registerContextContributor(type, loader)`** (exported from
  `@/lib/orchestration/chat`) — registers a prompt-context loader for a new
  `buildContext` `contextType`, so a fork can inject its own `LOCKED CONTEXT`
  block per turn without editing the core switch. Built-in cases take precedence;
  the 60 s per-`(type, id)` cache and invalidation behaviour are preserved. A
  contributor (or the fork's one-time init) that throws is caught and degraded
  so a loader error never fails the chat turn; the errored-contributor
  placeholder alone is returned uncached, so a transient loader failure
  self-heals on the next turn. Auto-wired once via the new fork-owned empty
  scaffold
  `lib/app/context-contributors.ts` → `initAppContextContributors()` (mirrors
  `lib/app/capabilities.ts`). (#372)

## [0.4.1] — 2026-07-01

> **Alpha release.** Sixth tagged Sunrise release. **PATCH bump** — no change to
> the covered public surface (see [`VERSIONING.md`](./VERSIONING.md#covered)):
> one backward-compatible enhancement to an uncovered `lib/db/` helper plus
> routine dependency and CI maintenance. Cut as a clean forking point. Ships in
> `0.x` per [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design).

### Changed

- `executeTransaction()` (`lib/db/utils.ts`) now accepts an optional second
  argument forwarding Prisma's interactive-transaction options
  (`timeout`, `maxWait`, `isolationLevel`) to `prisma.$transaction`. Fully
  backward-compatible — existing callers keep Prisma's defaults (5000 ms
  timeout / 2000 ms maxWait). Lets forks raise the ceiling for genuinely heavy
  callbacks (e.g. bulk imports over remote/pooled Postgres) without patching the
  core utility. [#368]

## [0.4.0] — 2026-06-30

> **Alpha release.** Fifth tagged Sunrise release. **MINOR bump** — adds new
> public surface: the per-surface theming seam (`data-surface` + the fork-owned
> `classifySurface` / `DEFAULT_SURFACE` policy in `lib/app/surface.ts`,
> `<SurfaceSync>`, and the empty `app/brand-theme.css`), the agent field registry
> (`AGENT_FIELDS` + the `AgentFieldDescriptor` type and selectors, with the
> fork-owned `lib/app/agent-fields.ts` seam), the knowledge-document
> cross-environment export key (`AiKnowledgeDocument.slug` + the bundle/backup
> `knowledgeDocumentSlugs` grant round-trip), point-in-time agent versioning with
> system-agent restore, and the legal-name brand seam (`BRAND.legalName` /
> `NEXT_PUBLIC_LEGAL_NAME`) — plus fixes to backup import on a fresh target and the
> email-subject branding. Ships in `0.x` per
> [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) — forks
> adopting this release should expect real merge work between any two `0.x`
> releases. Note: existing pre-`0.x` agent version rows are reinterpreted under
> the new point-in-time model (see the Changed entry).

### Added

- **Legal-name brand seam (`BRAND.legalName` / `NEXT_PUBLIC_LEGAL_NAME`).** The
  public footer copyright now attributes to a fork's legal entity rather than its
  product name. `lib/brand.ts` gains `legalName`, defaulting to
  `NEXT_PUBLIC_LEGAL_NAME` → `NEXT_PUBLIC_APP_NAME` → `"Sunrise"`, so a fork that
  only renames the app is byte-for-byte unchanged; set `NEXT_PUBLIC_LEGAL_NAME`
  (registered in `lib/env.ts`) when the copyright holder differs from the product
  (e.g. product "ConQuest" © "All Too Human Ltd"). Deliberately broader than
  "copyright holder" so it can later drive other legal surfaces (Terms/Privacy
  boilerplate, email footers). See `CUSTOMIZATION.md` §2. (#363)

- **Per-surface theming seam (`data-surface`) + fork-owned `app/brand-theme.css`.**
  A fork can now repaint one rendering surface (e.g. its consumer-facing pages)
  with its own palette/typography while leaving others (e.g. `/admin`) on the
  Sunrise defaults — without editing `app/globals.css` or any platform layout.
  `proxy.ts` classifies each request via the fork-owned `classifySurface(pathname)`
  policy seam (`lib/app/surface.ts`, exporting the `Surface` type) and forwards an
  `x-surface` request header; the root layout renders `<html data-surface>`; the
  new `<SurfaceSync>` client component (`components/surface-sync.tsx`) keeps that
  attribute correct across App Router navigation. The fork's per-surface CSS-variable
  overrides live in `app/brand-theme.css`, which **ships empty** — vanilla Sunrise
  is visually unchanged until a fork fills it. Documented (including the six
  design constraints — `<html>`-level marker for portals, the client re-sync, the
  subtree pin, the two dark-mode selector forms, the `:has()` backdrop, and
  unlayered overrides) in
  [`.context/ui/surface-theming.md`](.context/ui/surface-theming.md).
- **Agent field registry + fork-owned `lib/app/agent-fields.ts` seam.** A single
  declarative descriptor per `AiAgent` config field
  (`lib/orchestration/agents/agent-field-registry.ts`, exporting `AGENT_FIELDS`,
  the `AgentFieldDescriptor` type, and the `versionedFieldNames` /
  `snapshotFieldNames` / `fieldLabels` / `fieldToTab` / `fieldOrder` selectors)
  replaces the ~15 disconnected hand-maintained field lists that previously had
  to be kept in lockstep. The scalar set is exhaustiveness-checked against
  Prisma's generated `AiAgentScalarFieldEnum`, so adding a column without a
  descriptor is a compile error rather than a silent runtime gap. Forks add
  their own agent fields in the empty fork-owned scaffold `lib/app/agent-fields.ts`
  (`appAgentFields`) without editing a platform list. The registry is the source
  of truth (derived) for the versioning, snapshot, diff, restore, PATCH, and
  clone surfaces; parity tests keep the create/update validation schemas and the
  export bundle / full-backup schemas in lockstep with it, so adding a field to
  one without the other is a loud test failure. Documented in
  [`.context/orchestration/agent-fields.md`](.context/orchestration/agent-fields.md).
- **`AiKnowledgeDocument.slug` — stable cross-environment export key** (`@unique`,
  added by migration `20260629120000_add_knowledge_document_slug` with a
  deterministic backfill). Mirrors `KnowledgeTag.slug`: the slug is
  `slugify(name) + '-' + first8(fileHash)` (helper
  `lib/orchestration/knowledge/document-slug.ts` — `buildDocumentSlugBase`,
  `generateUniqueDocumentSlug`), so the same document keys identically in any
  environment. This is the prerequisite that lets **agent→document grants
  round-trip** through export/import and backup/restore (#338). `slugify` is now
  exported from `lib/orchestration/knowledge/chunker.ts`. Documented in
  [`.context/orchestration/knowledge.md`](.context/orchestration/knowledge.md).
- **Newly-exported validation surfaces** (`lib/validations/orchestration.ts`):
  `createAgentObjectSchema` / `updateAgentObjectSchema` (the agent create/PATCH
  field shapes without their cross-field refinement, so other call sites — e.g.
  version restore — can reuse the same per-field validators) and
  `bundledAgentSchema`; plus `agentBackupSchema` from
  `lib/orchestration/backup/schema.ts`. Exported to anchor the registry parity
  tests.

### Changed

- **Agent version snapshots are now point-in-time** (`AiAgentVersion.snapshot`
  holds the config _as of_ that version, the post-save state — previously it held
  the pre-update state). "Restore to vN" now reproduces the agent exactly as it
  was at vN, so version labels match their content and the newest row equals the
  live agent. Every agent now gets an explicit **`v1` ("Initial configuration")**
  at create and clone, a new seed unit (`020-agent-initial-versions`) backfills
  one for pre-existing agents, and the first edit of a legacy agent with no rows
  backfills its pre-edit state as `v1` — so a single later edit is always
  recoverable. New shared helper `lib/orchestration/agents/agent-versioning.ts`
  (`buildAgentSnapshot`, `nextAgentVersionNumber`, `INITIAL_VERSION_SUMMARY`).
  _Existing pre-`0.x` version rows are reinterpreted under the new model; during
  `0.x` alpha this is acceptable (forks expect migration work between releases)._
- **System agents are now version-restorable.** `POST /agents/:id/versions/:versionId/restore`
  no longer returns 403 for `isSystem` agents; it applies the snapshot while
  skipping the read-only fields (`slug`, `systemInstructions`, `isActive`),
  mirroring the PATCH route's guards. (Resolves the open question in #330.)
- **Agent→document grants now round-trip through export/import and backup** (#338).
  The agent bundle (`bundledAgentSchema`) carries a new `knowledgeDocumentSlugs`
  array; `POST /agents/export` emits it and `POST /agents/import` reconnects it by
  `AiKnowledgeDocument.slug`, **failing the whole import** with an actionable
  message when a referenced document is absent (matching the existing
  profile/tag behaviour). The full backup schema bumps to **`schemaVersion: 3`**:
  document grants move from `grantedDocumentHashes` (`fileHash`) to
  `grantedDocumentSlugs` (`slug`); v2 bundles still import (the importer falls back
  to `fileHash` lookup when no slugs are present, and document misses there remain
  warn-skip, consistent with the backup importer's leniency).

### Fixed

- **Backup import to a fresh environment no longer crashes on `knowledgeCategories`.**
  The full-config backup importer's agent CREATE branch spread the parsed agent
  into `prisma.aiAgent.create`, leaking the wire-only `knowledgeCategories` field
  (kept for old-bundle back-compat) whose column was dropped in Phase 6. Prisma
  rejected the unknown argument and rolled back the entire import — exactly the
  primary disaster-recovery / new-environment restore path (the UPDATE/overwrite
  path was unaffected). The field is now stripped before the spread, and a
  regression test exercises the CREATE path against a create that rejects unknown
  arguments (the prior tests mocked it away). (#353)

- **Agent version restore now reconnects knowledge grants and `knowledgeAccessMode`.**
  Restore previously left an agent's tag/document grants and access mode at their
  current values (the grants were captured in the snapshot but never reapplied,
  and `knowledgeAccessMode` was deliberately skipped to avoid pairing it with
  stale grants — see #333). Restore now reapplies the snapshot's grants (dropping
  any tag/document deleted since, so a stale id can't FK-fail the restore) and
  mode together, then invalidates the access-resolver cache so the next chat turn
  sees the restored scope.

- **Email subject lines now honor the `BRAND.name` seam.** Five transactional
  email subjects (contact-form notification, welcome on signup, welcome after
  verification, user invitation, admin webhook test) hardcoded the literal
  `"Sunrise"` while their bodies already used `BRAND.name` — so a fork setting
  `NEXT_PUBLIC_APP_NAME` got branded bodies but stale subjects (and a
  subject/body mismatch on the invitation). All five now interpolate
  `BRAND.name`. Vanilla Sunrise is unchanged (the name defaults to `"Sunrise"`).
- **Full-config backup no longer silently drops agent fields.** The
  backup/restore agent schema, exporter, and importer had drifted from the
  `AiAgent` model and omitted `kind`, `reasoningEffort`, `persona`, `guardrails`,
  the three inheritance `*Mode` fields, the three attachment toggles, and the two
  runtime-prompt fields — so exporting and re-importing a config reset a `judge`
  agent to `chat` and lost persona/guardrails/toggles. All are now serialized and
  restored (additive, optional-with-default schema fields, so older bundles still
  import unchanged). A registry parity test now fails if any config field is
  missing from the bundle or backup schema.
- **Agent version history no longer silently loses fields.** `persona`,
  `guardrails`, `personaMode`, `voiceMode`, and `guardrailsMode` were treated as
  versioned (editing them logged a "changed" version) but were never written to
  the snapshot, so the change was unrecoverable; `reasoningEffort` and
  `maxCostPerTurnUsd` were captured but invisible in the diff viewer. All are now
  snapshotted, diffed, and restored. Version **restore** likewise applies the
  full versioned field set (previously its hand-maintained apply-list dropped
  persona/guardrails/modes and the knowledge/runtime-prompt fields) and validates
  the stored snapshot against the same per-field rules a PATCH uses.

## [0.3.0] — 2026-06-26

> **Alpha release.** Fourth tagged Sunrise release. **MINOR bump** — adds new
> public surface (the `<BrandMark>` header/footer brand slot, the public-nav /
> footer override seam — `publicNavItems` / `footerNavItems` / `footerLegalItems`
> with the `PublicNavItem` type and `DEFAULT_*` lists — and the email-template
> resolver `resolveEmailTemplate` with the `EmailKind` / `EmailPropsMap` /
> `EmailOverrides` contract) on top of the anonymous-visitor observability seam
> (`visitorId` log context, `getVisitorId()`, the `LogContext.visitorId` /
> `ChatRequest.visitorId` fields, and the `LOG_VISITOR_ID` / `LOG_HTTP_ACCESS`
> env flags). Ships in `0.x` per
> [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) — forks
> adopting this release should expect real merge work between any two `0.x`
> releases.

### Added

- **Fork-readiness seams — header/footer brand, public nav, and auth emails.**
  Three near-universal fork customizations no longer require editing
  Sunrise-core files in place (which conflicts on every upstream sync); each is
  now a **fork-owned scaffold** the platform auto-resolves against, with a
  platform default. New public surface: the `<BrandMark>` slot
  (`components/brand/brand-mark.tsx`) — the header/footer brand is a render
  concern (image/wordmark/text), so the seam is a component; `AppHeader` renders
  it where it previously hardcoded `'Sunrise'`, and `logoText` becomes an
  optional caller override with no default. The public-nav override
  (`lib/app/public-nav.ts`) exports `publicNavItems` / `footerNavItems` /
  `footerLegalItems` (`PublicNavItem[] | null`, default `null` = platform
  default; a non-null array **replaces** it wholesale), with the shared
  `PublicNavItem` type and `DEFAULT_PUBLIC_NAV` / `DEFAULT_FOOTER_NAV` /
  `DEFAULT_FOOTER_LEGAL` in `lib/public-nav/types.ts`; the footer's **Cookie
  Preferences** consent control is always rendered regardless of the legal
  override. The email resolver (`lib/email/registry.ts`) adds
  `resolveEmailTemplate(kind, props)`, the `EmailKind` union, the typed
  per-kind `EmailPropsMap` props contract, and `EmailOverrides`; forks register
  per-kind overrides in `lib/app/emails.ts` and platform call sites
  (`lib/auth/config.ts`, `app/api/v1/users/invite/route.ts`) resolve through it.
  Changing an email kind's props is a versioned public-surface change. Vanilla
  Sunrise output is unchanged when no override is set. See
  [`CUSTOMIZATION.md`](./CUSTOMIZATION.md) §2 and §4. [#347]
- **Anonymous visitor observability — durable signed `visitorId` in server logs.**
  The proxy now issues a durable, HMAC-signed `sunrise_vid` cookie (HttpOnly,
  SameSite=Lax, Secure in production, 180-day TTL) and folds a `visitorId` into
  the log context alongside `requestId`, so an anonymous visitor's journey
  (page load → contact form → chat) can be correlated across requests for error
  reproduction — where the per-request `requestId` cannot. New public surface:
  the `LogContext.visitorId` field; `getVisitorId()` and the `visitorId` field
  on `getRequestContext()` / `getFullContext()` in `lib/logging/context.ts`; the
  `ChatRequest.visitorId` field threaded through `streamChat()`; the
  `lib/logging/visitor-id.ts` signing module; and two env flags — `LOG_VISITOR_ID`
  (default **on**, set `false` to disable) and `LOG_HTTP_ACCESS` (default **off**,
  opt-in per-request proxy access log). The signing key is derived from
  `BETTER_AUTH_SECRET` via HKDF with domain separation; the cookie is
  tamper-verified and the proxy strips any spoofed inbound `x-visitor-id`
  header. The `visitorId` is pseudonymous and covered by log-retention windows,
  not the `eraseUser()` cascade. See
  [`.context/logging/visitor-tracing.md`](./.context/logging/visitor-tracing.md)
  and [`.context/privacy/visitor-id.md`](./.context/privacy/visitor-id.md). [#341]

## [0.2.0] — 2026-06-25

> **Alpha release.** Third tagged Sunrise release. **MINOR bump** — adds new
> public surface (the `transcribeStream` streaming speech-to-text provider seam
> with the `TranscribeChunk` / `TranscribeAudio` types, optional
> provider-enforced structured output on `runStructuredCompletion`, and the
> `AiAgent.runtimePromptManaged` / `runtimePromptNote` honesty flag) on top of
> the Anthropic structured-output hardening and the agent export/import bundle
> fidelity fix below. Ships in `0.x` per
> [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) — forks
> adopting this release should expect real merge work between any two `0.x`
> releases.

### Added

- `AiAgent.runtimePromptManaged` (Boolean, default `false`) and
  `AiAgent.runtimePromptNote` (nullable String) — an advisory, behaviour-neutral
  honesty flag for agents dispatched for their provider/model binding only,
  whose system prompt is assembled in application code per call (the capability
  pattern) rather than read from the stored `persona` / `systemInstructions` /
  `guardrails` / `brandVoiceInstructions` fields. When set, the admin agent
  form's Instructions tab shows a non-dismissible callout and re-labels the
  "Effective prompt preview" as **not** what the LLM receives, so an operator
  isn't misled into tuning inert instruction fields. App-populated; round-trips
  through the agent create/GET/PATCH API and is captured in version snapshots.
  The runtime never reads it — no execution-path change. (#304)
- `runStructuredCompletion` (`lib/orchestration/evaluations/parse-structured.ts`)
  accepts optional `responseSchema` / `responseSchemaName` / `responseSchemaStrict`
  on `StructuredCompletionOptions`. When `responseSchema` is supplied it is
  forwarded as a `json_schema` `responseFormat` on both the first attempt and
  the temp-0 retry, so supporting providers enforce the output shape
  (OpenAI-compatible `response_format`; Anthropic forced-tool extraction)
  instead of relying on the prompt's prose alone. Purely additive — callers
  that don't opt in are unchanged, and providers without support ignore the
  field (the `parse` + retry path remains the cross-provider safety net). (#307)
- Streaming speech-to-text provider seam: optional `transcribeStream?()` on the
  `LlmProvider` interface (the streaming analogue of `transcribe()`), a new
  `TranscribeChunk` union (`partial` / `final` / `done` with `audioSeconds`) and
  `TranscribeAudio` type, and a `streamTranscription()` / `batchTranscribeAsStream()`
  helper (`lib/orchestration/llm/transcribe-stream.ts`) that prefers native
  streaming, falls back to adapting a batch `transcribe()` into a single
  `final` + `done` stream, and raises `ProviderError` `not_supported` when the
  provider can transcribe by neither path. Billed by `audioSeconds`, identical
  to the batch path. Platform seam only — the client transport and live
  `MicButton` mic layer remain a follow-up (the transport spike); the batch
  `transcribe()` path is unchanged and stays the default. (#308)

### Fixed

- Anthropic structured-output (forced-tool extraction) robustness on the
  `json_schema` `responseFormat` path: (1) the extraction tool name derived
  from `responseFormat.name` is now slugified + length-capped to satisfy
  Anthropic's `^[a-zA-Z0-9_-]{1,64}$` tool-name rule (a name with spaces or
  over the cap previously 400'd on Anthropic only); (2) a `max_tokens`
  truncation during extraction now raises the actionable `truncated_no_output`
  error instead of degrading into a malformed-JSON parse failure (the partial
  tool input was non-empty content, so the prior empty-output guard missed it);
  (3) a non-object-rooted schema is now rejected with a clear `invalid_schema`
  error rather than being silently coerced to `object` and sent as an
  incoherent `input_schema`. Behaviour change: callers passing a non-object
  root schema to Anthropic now get a local error (previously a provider-side
  failure). (#335)
- Agent export/import bundle now round-trips the full agent configuration.
  Previously the bundle silently dropped many `AiAgent` fields on export/import
  (`kind`, `persona`, `guardrails`, `personaMode`/`voiceMode`/`guardrailsMode`,
  `knowledgeAccessMode`/`knowledgeRetrievalMode`/`knowledgeTriggerKeywords`,
  `enableVoiceInput`/`enableImageInput`/`enableDocumentInput`,
  `runtimePromptManaged`/`runtimePromptNote`) and never wrote `maxCostPerTurnUsd`
  on import. The bundle now also carries the linked **profile** and granted
  **knowledge tags** by slug and re-links them on import; a referenced profile
  or tag missing in the target environment fails the import with an actionable
  message (rather than silently dropping the agent's identity / knowledge
  scoping). Agent→document grants are intentionally still not carried —
  documents lack a stable cross-environment key (tracked in #338). Older bundles
  remain importable (all new fields are optional/defaulted). (#332)

## [0.1.0] — 2026-06-24

> **Alpha release.** Second tagged Sunrise release. **MINOR bump** — adds new
> public surface (the `registerAppDriftProbe` drift-probe seam, the
> `User.accountType` field, and the `NEXT_PUBLIC_APP_NAME` brand seam) on top of
> the auth-bootstrap hardening and the orchestration fixes below. Ships in `0.x`
> per [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) —
> forks adopting this release should expect real merge work between any two `0.x`
> releases; the strict SemVer contract activates at `1.0.0`.

### Added

- **App-extensible database drift-probe seam — `lib/app/db-drift.ts`** (issue
  #284). A new auto-wired `lib/app/*` seam exporting `registerAppDriftProbes()`,
  so a fork can register its **own** Prisma-unmodelled DB objects (hand-written
  FK constraints, custom indexes, CHECK constraints) and have
  `npm run db:drift-check` (CI + `/pre-pr`) probe them alongside Sunrise's
  A-series — without editing the platform-owned `scripts/db/check-drift.ts`. New
  module `lib/db/drift-probes.ts` exposes the probe primitives (`indexExists`,
  `constraintExists`, `columnExists`) and registry (`registerAppDriftProbe`,
  `getAppDriftProbes`, `mergeDriftProbes`). `constraintExists`'s optional
  definition-substring argument is the documented home for a manual-FK `onDelete`
  policy (assert `ON DELETE CASCADE`/`SET NULL`), which the schema-level
  `onDelete` rule can't see. Registering a duplicate name, or one that shadows an
  A-series probe, throws. See `CUSTOMIZATION.md` §5 and
  `.context/database/prisma-unmodelled-objects.md`.
- **`AccountType` enum + `User.accountType` field** (`HUMAN` | `SERVICE`,
  default `HUMAN`) — a first-class axis, orthogonal to `role`, distinguishing
  real login users from non-login machine/system principals (the seeded
  config-owner). Migration `20260531115829_add_account_type`. New shared
  predicates `humanWhere` / `humanAdminWhere` / `serviceAccountWhere` in
  `lib/auth/account.ts` — the single source of truth every admin
  count/list/guard uses to exclude SERVICE principals.
- **`AuthBootstrap` Prisma model** (`auth_bootstrap` table) — a singleton marker
  recording that the one-time first-user-is-admin bootstrap has completed.
  Migration `20260531100706_add_auth_bootstrap`. New export: `AUTH_BOOTSTRAP_ID`
  from `lib/auth/constants.ts`.
- **`prisma/seeds/019-reconcile-legacy-seed-users.ts`** — one-time, idempotent
  upgrade reconciliation for databases seeded under v0.0.1: erases the legacy
  credential-less `admin@example.com` / `test@example.com` artifacts (preserving
  real users), re-points orphaned config ownership to the SERVICE owner, and
  marks the bootstrap complete on established instances.
- **`NEXT_PUBLIC_APP_NAME` brand seam** (issue #305) — a single optional env var
  renames the app's display name across page-title metadata (root + route-group
  layouts and the auth pages) and the email templates, with no file edits.
  Consumed via the new `lib/brand.ts` (`BRAND.name`), which reads
  `process.env.NEXT_PUBLIC_APP_NAME` directly so it is safe on both server and
  client; registered in `lib/env.ts` and `.env.example`. Defaults to `"Sunrise"`
  — unset leaves every surface byte-for-byte unchanged. Marketing-page body copy
  is intentionally out of scope (a separate content concern); `SUNRISE_VERSION`
  and internal platform identifiers deliberately do not use this seam.

### Changed

- **Auth bootstrap — first account on a fresh database becomes `ADMIN`.**
  `userCreateBeforeHook` (`lib/auth/config.ts`) promotes the first real account
  created on an empty database (email/password **or** OAuth) to `ADMIN`; every
  subsequent account is a regular `USER`. The promotion is one-time (gated on the
  `AuthBootstrap` marker, self-healing if a write is missed) and fails open — a
  DB error in the check never blocks signup. The seed unit formerly at
  `prisma/seeds/001-test-users.ts` is renamed to
  `prisma/seeds/001-system-owner.ts` and provisions a single non-login
  `system@sunrise.local` config-owner (`role: ADMIN`, `accountType: SERVICE`, no
  credential) instead of the login-able `admin@example.com` / `test@example.com`
  users. New export: `SYSTEM_USER_EMAIL` from `lib/auth/constants.ts`.
- **Orchestration seeds resolve the config owner deterministically** via
  `serviceAccountWhere` (the SERVICE account) rather than the first `ADMIN` row.

### Fixed

- **`PATCH /api/v1/admin/orchestration/settings` now accepts DB-managed model
  ids in `defaultModels`** (issue #302, Bug A). The handler hydrates the
  in-memory model registry from the `AiProviderModel` matrix before validating,
  so a discovery-added model (e.g. a date-stamped `gpt-5.5-pro-2026-04-23` that
  exists only in the DB, not the static registry) that the settings form offers
  in its dropdown is no longer rejected on save with `VALIDATION_ERROR` (400).
  Mirrors the other model-id paths (workflow execute, cost estimation) that
  already hydrate first.
- **`AiConversation` inbound unique key no longer triggers a phantom
  `ALTER INDEX ... RENAME` on every `prisma migrate dev`** (issue #283). The
  `@@unique([agentId, channel, fromAddress])` now pins its DB name with
  `map: "ai_conversation_inbound_key"`; Prisma 7's `migrate diff` ignored the
  `name:` argument for the DB object and re-derived the default name, injecting
  a spurious rename into every fork's generated migration. The Client-API
  compound key (`name:`) is unchanged, and existing deployed databases diff
  clean (no migration required).
- **Model discovery no longer mis-tiers date-stamped frontier models** (issue
  #302, Bug B). The name heuristics in `lib/orchestration/llm/model-heuristics.ts`
  now strip a trailing date stamp (`gpt-5.5-pro-2026-04-23`,
  `claude-3-5-sonnet-20241022`) before classifying, and recognise the flagship
  suffixes `pro` / `ultra` / `max` as frontier signals alongside `opus` and the
  o-series. A frontier "pro" model surfaced by discovery is now suggested as the
  `thinking` tier (→ `frontier` display) instead of falling through to
  `infrastructure` (→ `budget`). New export `stripModelDateStamp` from the same
  module. Operator review/override of a suggested tier is unchanged.
- **Knowledge document parsers no longer crash in a production build** (issues
  #315, #320). HTML and PDF ingestion threw only in the bundled production server
  (`next build && next start`) — invisible under `npm run dev` — so **any**
  production deployment (not just Vercel, where it first surfaced) returned a 500
  when ingesting those formats. Two independent bundling causes: jsdom ≥27's ESM
  `@exodus/bytes` fails to load under Next's production `require` path (pinned to
  `jsdom@^26`, with a Dependabot ignore for ≥27), and `pdf-parse` expects canvas
  globals (`DOMMatrix` et al.) that aren't present in the server bundle (now
  polyfilled). Parsers are also lazy-imported so a fork that doesn't ingest those
  formats never loads the browser-coupled deps.

### Security

- **Removed the documented-but-nonfunctional default seed credentials.** The
  README previously advertised `admin@example.com` / `test@example.com` with
  `password123`, but the seed never created the better-auth credential records,
  so those logins never worked. Sunrise now ships **zero default login
  credentials**; admin access is bootstrapped by the first-signup rule above.
- **Closed an admin re-bootstrap privilege-escalation window and related
  miscounts.** "Real human admin" is now a single predicate (`accountType:
  'HUMAN'`) routed through every admin count/list/guard — the last-admin
  self-delete guard, the bootstrap human-count, the admin dashboard stats, and
  the admin user list — so the non-login SERVICE config-owner can never be
  miscounted as an operator (which previously let the last human admin
  self-delete to zero and re-open the bootstrap). The SERVICE account is also
  immutable via the user-management API (`CANNOT_MODIFY_SYSTEM_ACCOUNT` /
  `CANNOT_DELETE_SYSTEM_ACCOUNT`), the bootstrap is gated on the persisted
  `AuthBootstrap` marker, and `SYSTEM_USER_EMAIL` is reserved at signup.

---

## [0.0.1] — 2026-05-30

> **Alpha release.** First tagged Sunrise release. Ships in `0.x` per
> [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) —
> forks adopting this release should expect real merge work between any two
> `0.x` releases. The strict SemVer contract activates at `1.0.0`.

The entries below are the fork-readiness pass — the work that makes
Sunrise safe to fork and to merge upstream releases into.

### Added

- **Versioning infrastructure** — `lib/sunrise-version.ts` (`SUNRISE_VERSION`
  constant), `lib/app-version.ts` (`APP_VERSION` — the fork-owned counterpart
  derived from `package.json.version` via a direct import, eliminating the
  brittle `process.env.npm_package_version` detour), `VERSIONING.md`
  (public-surface contract), this `CHANGELOG.md`, and a `sunrise` field on
  the public `/api/health` response so any deployment exposes which Sunrise
  it's running. Includes `lib/validations/monitoring.ts` (Zod schema for
  runtime validation of the health-response shape at the client boundary).
- **Fork-extension seams** (the registries batch) — auto-wired `lib/app/`
  surface for forks to register their own capabilities, admin nav sections,
  rate-limit tiers/rules, and environment variables without touching platform
  code. Includes an ESLint app-boundary that keeps `lib/app/**` portable.
- **GDPR data erasure** — `eraseUser()` service with cascade / `SetNull`
  policies on every `User` FK, a last-admin guard, and an erasure-hook
  registry for app-side residual cleanup that the schema-level cascade can't
  reach (`lib/privacy/erasure-hooks.ts`). The seed of the full data-erasure
  pattern; see [`.context/privacy/data-erasure.md`](./.context/privacy/data-erasure.md).
- **Multi-tenancy playbook** — opt-in playbook with a `TENANCY_MODE`
  environment seam and an inert `lib/tenancy/client.ts` so a fork can retrofit
  Postgres RLS without forking the platform. Sunrise stays single-tenant by
  default. See [`.context/architecture/multi-tenancy.md`](./.context/architecture/multi-tenancy.md).
- **Public fork-onboarding guide** — `CUSTOMIZATION.md` at repo root, covering
  the app/platform model, the `lib/app/` extension surface, the `package.json`
  dependency/script policy, the database-schema split (your models go in
  `prisma/schema/app.prisma`), and the upstream-sync recipe.
- **Schema-folder split** — Prisma schema split into domain files under
  `prisma/schema/`, with `prisma/schema/app.prisma` reserved for fork-owned
  models. Keeps platform vs app models visually separable on every diff.
- **Migration baseline squash** — 106 dev-history migrations folded into a
  single fork-ready `prisma/migrations/` baseline. Forks adopting this
  release inherit a clean, reviewable migration history rather than the full
  pre-fork churn. See `.context/database/migrations.md` for the reconciliation
  recipe and `npm run db:drift-check` for the drift-detection tooling.
- **Capability quarantine / emergency-disable** — admin orchestration API
  surface for disabling a misbehaving capability without redeploying or
  unbinding it from agents. Includes quarantine-attribution metadata, a
  quarantined-capabilities banner on affected agent pages, and an active-
  quarantines dashboard panel under `/admin/orchestration`. See the
  orchestration admin API reference and `.context/admin/orchestration.md`.
- **Orchestration admin list endpoints — pagination, search, sort** —
  admin list endpoints under `/api/v1/admin/orchestration/**` (agents,
  knowledge documents) now accept paged/search/sorted query parameters,
  with corresponding admin tables wired to use them. Reduces the
  rehydration cost for forks running large agent/knowledge inventories.
- **Agent profiles** — shared persona / voice / guardrails library that
  multiple agents can attach, with override / append composition modes
  resolved at runtime. See `.context/admin/orchestration-agent-profiles.md`
  (admin UI) and `.context/orchestration/agent-profiles.md` (resolver).

### Changed

- **Rate limiting is middleware-driven.** Section caps for `/api/v1/**` are
  enforced by `proxy.ts` via the policy table at
  `lib/security/rate-limit-policy.ts` — new routes inherit the `api` cap
  automatically. Per-flow sub-caps (chat-stream, audio, upload, etc.) remain
  in the handlers. See [`.context/security/rate-limiting.md`](./.context/security/rate-limiting.md).
- **Knowledge-base default seeding is self-healing.** `npm run db:seed`
  re-derives the `kb_default` row when missing rather than failing fast on a
  pre-existing database that's lost the seed — relevant for forks pulling the
  squashed baseline into an existing dev environment.

---

[Unreleased]: https://github.com/human-centric-engineering/sunrise/compare/v0.11.2...HEAD
[0.11.2]: https://github.com/human-centric-engineering/sunrise/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/human-centric-engineering/sunrise/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/human-centric-engineering/sunrise/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/human-centric-engineering/sunrise/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/human-centric-engineering/sunrise/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/human-centric-engineering/sunrise/releases/tag/v0.0.1
