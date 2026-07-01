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

[Unreleased]: https://github.com/human-centric-engineering/sunrise/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/human-centric-engineering/sunrise/releases/tag/v0.0.1
