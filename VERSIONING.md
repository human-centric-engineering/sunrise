# Versioning

The versioning contract for the Sunrise **platform** — what each release number
commits to, what's covered, and what isn't.

**Audience:** Sunrise maintainers cutting releases, and fork authors deciding
whether an upstream upgrade is safe to merge. Cutting a release: see
[`CONTRIBUTING.md` → "Cutting a release"](./CONTRIBUTING.md#cutting-a-release).
Tracking the version inside a fork: see
[`CUSTOMIZATION.md` → "Tracking your Sunrise version"](./CUSTOMIZATION.md#8-tracking-your-sunrise-version).

---

## Status

Sunrise is currently **`0.x` (alpha)**. The strict [SemVer](https://semver.org/)
contract described below activates at `1.0.0`; during `0.x`, forks should expect
real merge work between any two releases. See
[SemVer §4](https://semver.org/#spec-item-4) for why that's allowed.

The current version of the platform lives in
[`lib/sunrise-version.ts`](./lib/sunrise-version.ts) as
`SUNRISE_VERSION`. Forks **do not** edit that file (see the
"Tracking the version in a fork" section below).

---

## What is Sunrise's version?

A fork has **two versions**, deliberately separate:

| Version           | Source of truth                                      | Exposed as a typed import via         | Owned by | What it means                                              |
| ----------------- | ---------------------------------------------------- | ------------------------------------- | -------- | ---------------------------------------------------------- |
| `version`         | `package.json`                                       | [`APP_VERSION`](./lib/app-version.ts) | The fork | The fork's app version (your product)                      |
| `SUNRISE_VERSION` | [`lib/sunrise-version.ts`](./lib/sunrise-version.ts) | (the file itself)                     | Sunrise  | The upstream platform version this checkout corresponds to |

`APP_VERSION` imports `package.json` directly at module load — it is not
derived from `process.env.npm_package_version`, which is unset under common
production launchers (Docker `CMD ["node", ...]`, Next.js standalone, PM2,
some serverless runtimes). The two constants `APP_VERSION` and
`SUNRISE_VERSION` are the canonical import sites; server-side code should
read these rather than reaching into `package.json` or hard-coding a literal.

Both are surfaced on the (public) `/api/health` endpoint as `version` and
`sunrise` respectively, so operators and the eventual HCE Hub can ask any
deployment which Sunrise it's on without guessing.

**Why two?** Because if `SUNRISE_VERSION` were derived from
`package.json.version`, Sunrise's version would silently follow whatever the
fork sets — making _"which Sunrise are you on?"_ unanswerable. The two files
are deliberate siblings: `lib/sunrise-version.ts` is Sunrise-owned (forks
never edit it, upstream merges keep it current); `lib/app-version.ts` is
fork-owned-by-reference (its body imports `package.json`, which the fork
edits on every app release).

---

## Public-surface contract (tight definition)

Every release decision ("is this MAJOR or MINOR?") collapses to _"did the public
surface change, and how?"_ This list **is** the public surface; nothing else is
covered by the version contract.

### Covered

- **Named seams** — the registry-based extension points. Currently:
  - capability registry (`lib/app/capabilities.ts` → `registerAppCapability()`)
  - admin nav registry (`lib/app/admin-nav.ts` → `registerNavSection()`)
  - erasure-hook registry (`lib/privacy/erasure-hooks.ts`)
  - ESLint app-boundary configuration for `lib/app/**`
  - app env registry (`lib/app/env.ts` → `appEnvSchema`)
  - rate-limit registry (`lib/app/rate-limit.ts` → `registerRateLimitTier()` / `registerRateLimitRule()`)
  - drift-probe registry (`lib/app/db-drift.ts` → `registerAppDriftProbe()`, primitives in `lib/db/drift-probes.ts`)
  - context-contributor registry (`lib/app/context-contributors.ts` → `registerContextContributor()`)
  - tenancy seam (`TENANCY_MODE` + `lib/tenancy/client.ts`)
- **Documented public APIs** —
  - `withAuth()`, `withAdminAuth()` from [`lib/auth/guards.ts`](./lib/auth/guards.ts)
  - `successResponse()`, `errorResponse()` from `lib/api/responses.ts`
  - `serverFetch()` from `lib/api/server-fetch.ts`
  - `logger` from `lib/logging/`
  - The orchestration admin API surface documented in
    [`.context/api/orchestration-endpoints.md`](./.context/api/orchestration-endpoints.md)
- **Published Prisma model interfaces** —
  - `User`
  - The `Ai*` orchestration models the admin API exposes (see
    [`.context/orchestration/admin-api.md`](./.context/orchestration/admin-api.md))

### Not covered

- Internal `lib/orchestration/<deep internals>` — executors, the registry's
  internal types, helpers not re-exported from a documented module.
- Undocumented helpers and internal types anywhere in `lib/`.
- The precise SQL of any individual migration. (The schema interface is
  covered; how a given migration got there is not.)
- Anything not exported from a documented module.

> **We can widen this list without a MAJOR bump; we can only narrow it with a
> MAJOR bump.** That asymmetry is why the contract defaults tight — promising
> coverage we later need to remove is the painful direction. If something not
> on the list ought to be, raise it; we can promote it in a MINOR.

---

## SemVer rules (at 1.0+)

Once the platform graduates to `1.0.0`, releases obey `MAJOR.MINOR.PATCH`
strictly:

- **MAJOR** — **incompatible** change to the public surface. Forks must do real
  merge work.
  - A seam's signature changes incompatibly (e.g. `registerNavSection()` gains
    a required argument).
  - An exported public API is removed (e.g. `withAuth()` deleted).
  - A published Prisma model field is dropped, renamed non-additively, or has
    its type narrowed.
- **MINOR** — **additive** change to the public surface. Forks merge cleanly.
  - A new seam (e.g. a new registry).
  - A new optional capability or argument on an existing seam.
  - A new published Prisma model, or a new optional column on one.
- **PATCH** — bug fixes, internal refactors, doc changes. Forks merge as a
  no-brainer.

> **Don't:** bump MAJOR for an _internal_ refactor that doesn't touch the
> public surface — the surface is the contract, not the implementation. If
> something internal moves and nothing in the "Covered" list above changes,
> it's a PATCH.

---

## `0.x` (alpha) semantics — loose by design

SemVer explicitly allows this:

> Major version zero (0.y.z) is for initial development. Anything MAY change at
> any time. The public API SHOULD NOT be considered stable.
> — [SemVer §4](https://semver.org/#spec-item-4)

In practice, during `0.x`:

- Bump **MINOR** for meaningful new public surface; **PATCH** for fixes.
- We are **not** obligated to bump MAJOR for breaking changes — we'd be stuck
  at `0.x` forever if we did, since by definition the surface isn't stable
  yet. Breaking changes still get a CHANGELOG entry; they just don't force
  a MAJOR.
- `SUNRISE_VERSION` still updates per release, so forks can pin to a known
  revision. They just shouldn't expect SemVer's strict guarantees between two
  `0.x` versions.
- **Forks should expect real merge work between any two `0.x` releases.**
  Adopt the platform at this stage knowing the surface is still settling.

---

## Graduating to 1.0

There are no pre-set graduation criteria. `1.0.0` is the deliberate "we'll
commit to the SemVer contract above" decision — a judgement call between the
Sunrise maintainers when the surface "feels right" and at least one production
app has shipped on Sunrise.

When we graduate, the strict rules above kick in: a MAJOR bump from that point
on means a real break in the contract, and forks can rely on MINOR/PATCH
upgrades being safe to merge.

---

## Release cadence: release-on-demand

Releases are tagged deliberately, not on every merge to main. A release means
_"we believe this batch is worth depending on"_ — there's an explicit
checkpoint, a dated `CHANGELOG.md` entry, and a `vX.Y.Z` git tag.

The trade-off: between releases, `main` may have commits not yet reflected in
the version. A fork tracking `main` is effectively on `vX.Y.Z + N unreleased
commits`. That's acceptable for the current stage; we'll reassess after a few
releases give us a feel for cadence.

Mechanics: [`CONTRIBUTING.md` → "Cutting a release"](./CONTRIBUTING.md#cutting-a-release).

---

## Tracking the version in a fork

If you're building **on** Sunrise rather than maintaining it, the fork-side
guide lives in
[`CUSTOMIZATION.md` → "Tracking your Sunrise version"](./CUSTOMIZATION.md#8-tracking-your-sunrise-version)
— where the constant lives, why it's separate from your `package.json.version`,
how it travels through upstream merges, and where you might surface it in
your own app.

---

## What's NOT (yet) part of the contract

These are mentioned in the proposal as **deferred past 1.0**. Don't depend on
any of them yet:

- **Pre-release tags** like `1.1.0-rc.1` — useful when external fork adoption
  grows; defer until then.
- **`git describe --tags`-derived version strings** — e.g. encoding "15 commits
  ahead of `v1.0.0`" automatically. Worth considering once we've shipped a few
  releases.
- **A `/api/sunrise-version` discovery endpoint** — only meaningful when the
  HCE Hub starts consuming it.
- **Automated release tooling** (`changesets`, `release-please`, etc.) —
  overkill until release frequency demands it.

When/if any of these land, they'll be added here.
