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

**Where each is surfaced, and why they differ.** `version` is on the public
`/api/health` endpoint — it is the fork's own number, means nothing outside that
fork, and container health checks and deploy scripts read it. `SUNRISE_VERSION`
is **not**: it is served from `GET /api/v1/admin/stats` as
`system.sunriseVersion`, behind `withAdminAuth`, and rendered on
`/admin/overview`.

It used to be on the health payload too, which meant the release a deployment
ran was disclosed to any anonymous caller — naming the published issues to try,
across every Sunrise-derived deployment rather than just one — while the
operator who needed it had no way to read it from the product at all. #531
inverted that: the operator can see it; a stranger cannot.

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

- **Named seams** — **every fork-owned scaffold in `lib/app/`**, plus the seams
  that live outside that directory. A fork fills a config scaffold exactly as it
  fills a registry, and a breaking change to either costs it the same merge, so
  both are covered. This list used to read "the registry-based extension
  points", which named seven of them and left every fork's `brand.ts`,
  `public-nav.ts` and `emails.ts` edits owed no announcement (#732).

  The `lib/app/` half below has its **paths** checked against the directory by
  `tests/unit/versioning-seam-coverage.test.ts`, in both directions — a file
  with no row, and a row with no file. The `→ export` beside each path is
  **not** checked and can go stale on a rename: this list carried
  `registerAppDriftProbe()` for the seam whose export is
  `registerAppDriftProbes()`. It
  classifies by exclusion — anything in `lib/app/` that is not a dotfile, a
  `.d.ts` or a `.md` is a scaffold and must be named here, whatever its
  extension — and a subdirectory counts as one scaffold, named with a trailing
  slash. The seams outside `lib/app/` are hand-maintained, because nothing
  derives them.

  Fork-owned scaffolds in `lib/app/` — a fork edits these, upstream ships them
  empty (or, for `surface.ts`, as a default it may replace):
  - `lib/app/account-sections.ts` → `initAppAccountSections()` — account-page section registry
  - `lib/app/admin-landing.ts` → `appOrgAdminLandingRoute` — where an org admin lands at `/admin` (checked by `orgAdminLandingProblem()` in `lib/auth/admin-landing.ts`)
  - `lib/app/admin-nav.ts` → `initAppNav()` — admin nav registry (`registerNavSection()`)
  - `lib/app/admin-tier.ts` → `initAppOrgTierAdminPages()` — the fork's org-tier admin pages, and the core sections it keeps platform-only (primitives: `registerOrgTierAdminPage()` and `closeCoreOrgTierSection()` in `lib/auth/admin-tier.ts`)
  - `lib/app/admin-tier-routes.ts` → `APP_ORG_TIER_ADMIN_ROUTES` — the fork's org-tier admin API routes and wrappers, as `path#NAME`, read by the roster test
  - `lib/app/agent-fields.ts` → `appAgentFields` — extra `AiAgent` config fields
  - `lib/app/api-key-scopes.ts` → `APP_API_KEY_SCOPES` — extra mintable API-key scopes
  - `lib/app/auth-landing.ts` → `appAuthLandingRoute` / `appAuthLandingLabel` — where sign-in lands
  - `lib/app/authorization.ts` → `initAppAuthorizationPolicy()` — the authorization policy: who administers, and over whose data (primitives: `registerAuthorizationPolicy()` / `DEFAULT_AUTHORIZATION_POLICY` in `lib/auth/authorization.ts`)
  - `lib/app/bootstrap.ts` → `initApp()` — the app boot hook, awaited by `instrumentation.ts`
  - `lib/app/brand.ts` → `appBrandName` / `appBrandLegalName` / `appBrandDescription` — brand overrides
  - `lib/app/capabilities.ts` → `initAppCapabilities()` — capability registry (`registerAppCapability()`)
  - `lib/app/capability-seed-pairs.ts` → `APP_CAPABILITY_PAIRS` / `APP_UNCHECKED_SEEDS` — which class goes with each slug the fork's capability seeds write, and which of its seeds the parity test cannot run, read by that test
  - `lib/app/ci.ts` → `appCoverageExclusions` / `appAlwaysRunTests` / `appOwnerlessSurfaceExceptions` — the fork's own coverage exclusions, whole-tree always-run tests, and files allowed to read an ownerless-capable model outside the access helpers
  - `lib/app/context-contributors.ts` → `initAppContextContributors()` — chat context contributors (primitive: `registerContextContributor()` in `lib/orchestration/chat/context-builder.ts`)
  - `lib/app/credential-paths.ts` → `appCredentialPaths` — route patterns whose dynamic segments are credentials, collapsed to `[param]` in every logged, reported and analytics path (read by `collapseDynamicSegments()` in `lib/logging/redact-path.ts`)
  - `lib/app/csp.ts` → `appFrameSrc` — extra CSP `frame-src` origins
  - `lib/app/data-export.ts` → `initAppSubjectSources()` / `collectAppSubjectData()` — Art. 15 export sources
  - `lib/app/db-drift.ts` → `registerAppDriftProbes()` — drift-probe registry (primitives in `lib/db/drift-probes.ts`)
  - `lib/app/emails.ts` → `emailOverrides` — transactional-email template overrides
  - `lib/app/env.ts` → `appEnvSchema` — app env registry
  - `lib/app/erasure.ts` → `initAppErasureHooks()` — Art. 17 erasure cleanup hooks and stale-writer declarations (primitives: `registerErasureCleanupHook()` and `registerStaleWriter()` in `lib/privacy/erasure-hooks.ts`)
  - `lib/app/eslint.config.mjs` — the fork's own ESLint tier config, spread into the root config
  - `lib/app/evaluations.ts` → `initAppGraders()` — evaluation grader registry
  - `lib/app/footer.ts` → `footerCopyright` — footer copyright line
  - `lib/app/guard-event-contributors.ts` → `initAppGuardEventContributors()` — output-guard event contributors
  - `lib/app/guard-floor-contributors.ts` → `initAppGuardFloorContributors()` — output-guard floor contributors
  - `lib/app/jobs.ts` → `initAppJobs()` — maintenance-tick job registry
  - `lib/app/knowledge-access-contributors.ts` → `initAppKnowledgeAccessContributors()` — knowledge document access
  - `lib/app/llm-providers.ts` → `registerAppProviderEligibility()` — provider-eligibility seam (primitive: `registerProviderEligibility()`, resolved through `lib/orchestration/llm/provider-eligibility.ts`)
  - `lib/app/mcp-resources.ts` → `initAppMcpResources()` — MCP resource-type registry
  - `lib/app/owner-classification.ts` → `initAppOwnerClassification()` — a fork's own models in the owner classification: personal (and enforced by the owner layer) or not (primitive: `registerAppOwnerClassification()` in `lib/db/owner-classification.ts`)
  - `lib/app/org-export.ts` → `initAppOrgSources()` — a fork's own tables in the org export (primitive: `registerAppOrgSources()` in `lib/privacy/org-source-registry.ts`)
  - `lib/app/platform-agents.ts` → `initAppPlatformAgents()` — platform agents every org gets an instance of (primitive: `registerPlatformAgent()` in `lib/orchestration/agents/platform-agents.ts`)
  - `lib/app/provider-credentials.ts` → `initAppProviderCredentials()` — where a provider row's API key comes from, per org (primitive: `registerProviderCredentialResolver()` in `lib/orchestration/llm/provider-credentials.ts`)
  - `lib/app/protected-nav.ts` → `protectedNavItems` — authenticated-area nav
  - `lib/app/protected-routes.ts` → `appProtectedRoutes` — extra route prefixes the proxy protects
  - `lib/app/public-nav.ts` → `publicNavItems` / `footerNavItems` / `footerLegalItems` — public nav and footer
  - `lib/app/rate-limit.ts` → `registerAppRateLimits()` — rate-limit registry (`registerRateLimitTier()` / `registerRateLimitRule()` / `registerRateLimitKeyResolver()`). The per-org request counter (`quotas.requestsPerMinute`, `lib/security/org-request-cap.ts`) runs outside this registry, and `'org'` stays free as a custom key name
  - `lib/app/tenant-resolver.ts` → `registerAppTenantResolver()` — the proxy's tenant resolver (primitive: `registerTenantResolver()` in `lib/tenancy/resolver.ts`; Web-standard only)
  - `lib/app/reserved-tiers.ts` → `occupiedTiers` — which reserved namespace tiers this fork occupies
  - `lib/app/own-modules.ts` → `appOwnModules` — a leaf fork's own `lib/app/` modules, which the seam-coverage guards then skip
  - `lib/app/surface.ts` → `classifySurface()` / `DEFAULT_SURFACE` — per-surface theming classifier
  - `lib/app/user-created.ts` → `initAppUserCreatedHooks()` — post-signup hook registry

  Outside `lib/app/` — **hand-maintained, so check it against the tree rather
  than trusting it.** The guard cannot derive this half, and a short list here
  is the same broken promise #732 was about:
  - erasure-hook registry (`lib/privacy/erasure-hooks.ts`)
  - tenancy seam (`TENANCY_MODE` + `lib/db/client.ts`, whose exported client
    is the base client through `withTenancy()` in `lib/db/tenancy-extension.ts`
    — `orgId` stamped on every tenant-owned create, every operation scoped by
    `set_config` at `multi`; the tenant context `lib/tenancy/context.ts`
    — `getTenantContext` / `requireTenantContext` / `requireOrgId` /
    `runAsOrg` / `runAsSystem` / `runAsCredentialLookup` / `forEachOrg`, and
    its `'support'` source with the `support` field (`SupportEntry`: the grant
    a support session entered under, §121 t-824) —
    the subject context `lib/auth/subject-context.ts` —
    `runAsSubject` / `getSubjectReadScope` / `runAcrossOwners` — the owner
    classification `lib/db/owner-classification.ts`
    (`OWNER_CLASSIFICATION` / `ownerClassificationOf` / `personalModels` /
    `enforcedModels`, and an entry's `enforced` flag) — and the owner
    chokepoint `lib/db/owner-extension.ts` over the tenancy client
    (`withOwnerChecks()`, and `OwnerReadRefusedError`, the error a refused
    read throws and `handleAPIError` answers as a 404) —
    plus the `x-sunrise-org` request-header contract between `proxy.ts` and
    the guards; and the operator surface that turns the capability on —
    `MIGRATE_DATABASE_URL`, `db:tenancy:enable|disable|role`,
    `orgIsolationPolicySql()` in `lib/tenancy/isolation.ts` — with the
    classification allowlists in `lib/tenancy/classification.ts` that a
    fork's model is tested against. Enabling it is
    [`.context/architecture/multi-tenancy.md`](./.context/architecture/multi-tenancy.md))
  - the ESLint app-boundary rule governing `lib/app/**` (root `eslint.config.mjs`)
  - brand mark component (`components/brand/brand-mark.tsx` — fork-owned scaffold; the default returns `BRAND.name` as a bare string, so a fork replaces markup rather than filling a blank)
  - fork theme (`app/brand-theme.css` — per-surface CSS-variable overrides, ships empty, imported by `app/layout.tsx`)
  - browser-tab icons (`app/favicon.ico`, `app/icon.svg` — fork-replaced assets on the Next file convention, linked by Next with no `layout.tsx` entry)
  - fork schema tier (`prisma/schema/app.prisma` — ships empty; the reserved `/app` and `/framework` tiers generally, see [`CUSTOMIZATION.md`](./CUSTOMIZATION.md#the-appplatform-model))

- **Documented public APIs** —
  - `withAuth()`, `withAdminAuth()`, their options (`resource`, `scope`, `ownership`/`RouteOwnership`, and `withAdminAuth`'s `tier`) and the `AuthenticatedSession` they hand a handler — `principal` and `subjectFilter` — from [`lib/auth/guards.ts`](./lib/auth/guards.ts)
  - admin tiers (§111): `AdminTier`, `ORG_TIER_ADMIN_PAGES`, `ORG_TIER_ADMIN_ROUTES`, `CORE_ADMIN_SECTIONS` and `adminPageTier()` from [`lib/auth/admin-tier.ts`](./lib/auth/admin-tier.ts), `orgTierAdminPages()` from [`lib/auth/org-tier-admin-pages.ts`](./lib/auth/org-tier-admin-pages.ts), `NavItem.tier` in `lib/admin-nav/registry.ts`, and the default policy's answer to `scope.tier: 'org'` — how a surface, a fork's included, places itself in the org tier (see [`.context/auth/authorization.md`](./.context/auth/authorization.md#admin-tiers))
  - `successResponse()`, `errorResponse()` from `lib/api/responses.ts`
  - `serverFetch()` from `lib/api/server-fetch.ts`
  - `logger` from `lib/logging/`
  - org support grants (§121): `GET`/`POST /api/v1/orgs/[id]/support-grants` and `DELETE /api/v1/orgs/[id]/support-grants/[grantId]`; `findOpenSupportGrant()`, `openSupportGrantWhere()`, `grantSupportAccess()`, `revokeSupportGrant()`, `listSupportGrants()` and `SupportGrantError` from `lib/tenancy/support-grants.ts`; `SUPPORT_GRANT_LEVELS` / `DEFAULT_SUPPORT_GRANT_LEVEL` from `lib/tenancy/roles.ts`; `SUPPORT_GRANT_DEFAULT_HOURS` / `SUPPORT_GRANT_MAX_HOURS` and `createSupportGrantSchema` from `lib/validations/tenancy.ts`; entry under a grant (t-824): `verifiedSupportGrant()` and the `'support'` `OrgEntry` source from `lib/tenancy/entry.ts`, the support principal's shape (the default user role in place of the platform role, on the principal and on the handler's session; `presentedRole()` / `presentedSession()` / `isRefusedReadOnlyWrite()` / `presentSessionEntry()` / `refuseReadOnlySupportWrite()` and `READ_ONLY_SUPPORT_MESSAGE` from `lib/auth/support-principal.ts`), `requestSupportSession()` from `lib/auth/admin-page-viewer.ts`, and `support` on the `POST /api/v1/orgs/switch` response; the support stamp on audit rows (t-825): `logAdminAction()` filling `supportGrantId` / `supportOrgId` from the tenant context, `AdminAuditEntry.support` for a caller acting on a session from outside it, `listSupportActivity()`, `GET /api/v1/orgs/[id]/support-grants/activity`, and the `support` / `supportGrantId` filters and `supportGrant` field on `GET /api/v1/admin/orchestration/audit-log` (see [`.context/tenancy/support-access.md`](./.context/tenancy/support-access.md))
  - an org's caps in `Org.settings.quotas` (`monthlyBudgetUsd`, `requestsPerMinute`): `readOrgQuotas()` / `loadOrgQuotas()` / `writeOrgQuotas()` and `ORG_QUOTAS_KEY` from `lib/tenancy/org-settings.ts`, with `orgQuotasSchema` / `OrgQuotas` from `lib/validations/tenancy.ts` — what a fork's billing or plan code calls to set an org's monthly budget and request cap
  - the per-org request counter's cache clear, `forgetOrgRequestCap()` from `lib/security/org-request-cap.ts` — called after a direct `writeOrgQuotas()` so the change applies at once in that process
  - The orchestration admin API surface documented in
    [`.context/api/orchestration-endpoints.md`](./.context/api/orchestration-endpoints.md)
- **Published Prisma model interfaces** —
  - `User`
  - `Org` and `OrgMembership` (`prisma/schema/tenancy.prisma`) — the identity a
    fork's own tenant-owned models bind to; see
    [`.context/tenancy/identity.md`](./.context/tenancy/identity.md)
  - `OrgSupportGrant` and `SupportGrantLevel` (`prisma/schema/tenancy.prisma`) — an
    org's consent for vendor support to act inside it; see
    [`.context/tenancy/support-access.md`](./.context/tenancy/support-access.md)
  - `AiAdminAuditLog.supportGrantId` (FK to `OrgSupportGrant`, `SetNull`) and
    `AiAdminAuditLog.supportOrgId` (no FK) — the grant and the org an audit row
    was made under, null outside a support session (§121 t-825)
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
