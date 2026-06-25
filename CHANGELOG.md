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

[Unreleased]: https://github.com/human-centric-engineering/sunrise/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/human-centric-engineering/sunrise/releases/tag/v0.0.1
