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

The following will ship in the first tagged Sunrise release (`v0.0.1`,
post-migration-squash). All entries are part of the fork-readiness pass: the
work that makes Sunrise safe to fork and to merge upstream releases into.

### Added

- **Versioning infrastructure** — `lib/sunrise-version.ts` (`SUNRISE_VERSION`
  constant), `VERSIONING.md` (public-surface contract), this `CHANGELOG.md`,
  and a `sunrise` field on the public `/api/health` response so any deployment
  exposes which Sunrise it's running.
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

### Changed

- **Rate limiting is middleware-driven.** Section caps for `/api/v1/**` are
  enforced by `proxy.ts` via the policy table at
  `lib/security/rate-limit-policy.ts` — new routes inherit the `api` cap
  automatically. Per-flow sub-caps (chat-stream, audio, upload, etc.) remain
  in the handlers. See [`.context/security/rate-limiting.md`](./.context/security/rate-limiting.md).

### Fixed

- See individual commits for the smaller fixes that landed alongside the
  fork-readiness work; the items above describe the substantive new contract
  shipping in the first tag.

---

[Unreleased]: https://github.com/human-centric-engineering/sunrise/compare/main...HEAD
