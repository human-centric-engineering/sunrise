# Multi-Tenancy Playbook

> **Update 2026-08-27 — partially superseded.** Sunrise has since decided to
> ship multi-tenancy as an **opt-in platform capability**; the binding design is
> [`multi-tenancy-design.md`](./multi-tenancy-design.md), and where the two
> disagree the design document wins. This playbook remains the proven data-plane
> recipe (the RLS pattern, the gotchas, the model inventory) and will be
> rewritten as the enablement guide when row isolation lands.
>
> **TL;DR — MT-possible, not MT-baked.** Sunrise ships **single-tenant by
> default** and contains **zero** tenancy machinery: no `Org` table, no `orgId`
> columns, no row-level security, no dormant fields. The one concession to
> multi-tenancy is an inert seam (`TENANCY_MODE`, default `single`) and this
> document. If you are running a normal single-tenant install, you can ignore
> all of it — nothing here is active.
>
> This is the **map** for a fork that needs multi-tenancy, not the destination.
> The RLS pattern below has been validated against real Postgres (see
> [The proof](#the-proof-runnable)); the empty-string footgun it caught is why
> the policy uses `NULLIF`.
>
> **Until the capability lands, whoever runs this recipe is a fork** (see the
> update above). So each step
> below also says where the artefact lives in your tier and whether it touches a
> Sunrise-owned file — see
> [Where a fork's tenancy code lives](#where-a-forks-tenancy-code-lives) and
> [Keeping the retrofit alive across upstream syncs](#keeping-the-retrofit-alive-across-upstream-syncs).
> The retrofit is not a one-off: upstream keeps shipping single-tenant code into
> your isolation boundary, and nothing in a merge tells you when it lands
> outside.

## Who this is for

A fork author who wants several customers (tenants/orgs) to share one Sunrise
deployment and one database, with hard data isolation between them. If instead
you want one deployment **per** customer, you do not need any of this — deploy
the template as-is, once per customer.

## What the template gives you to start from

Two things, and nothing else:

1. **A single client chokepoint.** Every one of the ~575 `prisma` importers
   gets the client from one module — [`lib/db/client.ts`](../../lib/db/client.ts).
   It builds **one** `PrismaClient` over a `pg` connection `Pool`. A fork wraps
   that single file and every call site inherits the change. No surgery across
   the codebase. (The `@/`-import discipline is what bought this — see the
   import rule in `CLAUDE.md`.)

2. **An inert seam.** `TENANCY_MODE` (in [`lib/env.ts`](../../lib/env.ts),
   default `single`) and a guard at the top of `lib/db/client.ts`. At `single`
   it is a no-op. Set it to `multi` and the client throws at startup with a
   pointer back here — so a half-finished fork fails loud instead of silently
   running unscoped queries with no isolation. You delete that guard as the last
   step of the retrofit.

## Where a fork's tenancy code lives

Sunrise has three fork levels and two reserved namespace tiers
([`CUSTOMIZATION.md`](../../CUSTOMIZATION.md#the-appplatform-model)):

```text
Sunrise (platform)      ← contains no tenancy machinery, ever
  └── framework fork    → lib/framework/, .context/framework/, prisma/schema/framework-*.prisma, framework_ prefix
        └── leaf fork   → lib/app/,       .context/app/,       prisma/schema/app.prisma
```

Both tiers ship **empty** upstream — that emptiness is what makes the files you
add there merge cleanly forever. Put the retrofit in the tier that owns the
tenant concept. If you are a **framework** fork selling multi-tenancy to your own
leaf forks, tenancy is `lib/framework/` (which does not exist upstream — you
create it); `lib/app/` belongs to your leaves and must stay free for them. If you
are a leaf fork, `lib/app/` is yours.

| Retrofit artefact                      | Fork-owned home                                                             | Touches a Sunrise-owned file?                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Org` / `OrgMembership` models         | `prisma/schema/app.prisma` (leaf) or `framework-tenancy.prisma` (framework) | No                                                                                                                             |
| `orgId` columns on **core** models     | `prisma/schema/*.prisma` — core files                                       | **Yes — unavoidable**                                                                                                          |
| RLS policy migration                   | a new `prisma/migrations/<ts>_app_rls_*/` folder                            | No — but it interleaves by timestamp ([`CUSTOMIZATION.md` §9](../../CUSTOMIZATION.md#9-staying-in-sync-with-upstream-sunrise)) |
| `withOrg` wrapper                      | `lib/db/client.ts`                                                          | **Yes — sanctioned.** This is the documented seam                                                                              |
| Tenant context (`AsyncLocalStorage`)   | `lib/{framework,app}/tenancy/context.ts`                                    | Yes, at the entry points that enter it (`guards.ts`, the tick)                                                                 |
| Tenancy env vars                       | `lib/app/env.ts` (`appEnvSchema`)                                           | No — existing registry seam                                                                                                    |
| Registry wiring at boot                | `lib/app/bootstrap.ts` (`initApp()`)                                        | No — existing registry seam                                                                                                    |
| Org-aware periodic work                | `lib/app/jobs.ts` (`registerAppJob`)                                        | No — existing registry seam                                                                                                    |
| Art. 15 export of your org-owned rows  | `lib/app/data-export.ts` (`collectAppSubjectData`)                          | No — existing registry seam                                                                                                    |
| CI assertion that policies still exist | `lib/app/db-drift.ts` (`registerAppDriftProbe`)                             | No — existing registry seam                                                                                                    |
| Org-scoped rate-limit rules and keys   | `lib/app/rate-limit.ts`                                                     | No — `registerRateLimitKeyResolver` opened the **key** space on 2026-09-01                                                     |
| Tenant-admin nav and route gating      | `lib/app/admin-nav.ts`, `lib/app/protected-routes.ts`                       | No — but the admin console split itself is platform-tier                                                                       |

**Exactly two sanctioned core edits**: the `withOrg` wrapper in
`lib/db/client.ts`, and `orgId` on the core schema files. Everything else that
reaches into `lib/auth/`, `lib/security/`, `lib/orchestration/`, `lib/storage/`
or `proxy.ts` becomes a conflict on every upstream sync.
[Research §8](./multi-tenancy-research.md#the-merge-conflict-surface-concretely)
lists the eighteen files concerned, which of the `lib/app/*` seams above absorb
work you would otherwise do in core, and
[which provisions upstream should ship](./multi-tenancy-research.md#provisions-upstream-should-ship)
so the rest stop being conflicts. Check that list before you copy a core file —
a local copy of `lib/auth/guards.ts` in particular turns a one-line future change
into permanent divergence.

## Why RLS, not app-layer `where: { orgId }`

The obvious approach — add `orgId` to every owned model and append
`where: { orgId }` to every query — has a hole the size of the orchestration
feature set. **Six modules issue raw SQL** that no Prisma `where` clause can
touch:

| File                                              | What it does               | Why `where:{orgId}` can't reach it                   |
| ------------------------------------------------- | -------------------------- | ---------------------------------------------------- |
| `lib/orchestration/knowledge/search.ts`           | pgvector similarity search | hand-written `$queryRawUnsafe` with vector operators |
| `lib/orchestration/knowledge/document-manager.ts` | chunk management           | raw `$executeRawUnsafe`                              |
| `lib/orchestration/knowledge/seeder.ts`           | embedding backfill         | raw SQL                                              |
| `lib/orchestration/chat/message-embedder.ts`      | message embeddings         | raw `$queryRaw` / `$executeRawUnsafe`                |
| `lib/orchestration/llm/cost-reports.ts`           | cost aggregation           | raw `$queryRawUnsafe`                                |
| `lib/db/utils.ts`                                 | health check (`SELECT 1`)  | no tenant data — exempt                              |

App-layer scoping would force you to hand-edit every one of those raw queries
and trust that no future raw query forgets the filter. **Postgres Row-Level
Security enforces isolation in the database, below the query API** — it covers
ORM queries and raw SQL identically, and a forgotten filter fails closed
instead of leaking. That is why the recipe below is RLS-based. The
[proof](#the-proof-runnable) demonstrates a raw `SELECT` obeying the policy
without any app-layer filter.

## Model inventory

The schema has **61 models**. Before adding `orgId` anywhere, classify them —
**a `createdBy` FK does NOT make a model tenant-owned.** Three categories:

### Tenant-owned — needs isolation

Data that belongs to a specific user/tenant. These get `orgId` + an RLS policy.
The direct owners (FK `userId` / `createdBy` / `uploadedBy`):

`Account`, `Session`, `AiAgent`, `AiAgentVersion`, `AiAgentEmbedToken`,
`AiAgentInviteToken`, `AiConversation`, `AiWorkflow`, `AiWorkflowVersion`,
`AiWorkflowExecution`, `AiWorkflowSchedule`, `AiWorkflowTrigger`,
`AiKnowledgeDocument`, `AiDataset`, `AiEvaluationSession`, `AiEvaluationRun`,
`AiExperiment`, `AiApiKey`, `AiUserMemory`, `AiWebhookSubscription`,
`AiEventHook`, `McpApiKey`, `McpExposedPrompt`.

Plus **child rows** that hang off the above by FK and have no owner column of
their own (`AiMessage`, `AiMessageEmbedding`, `AiKnowledgeChunk`,
`AiConversationShare`, `AiCostLog`, the workflow execution children, eval
case/log rows, …). You have two choices for these, both valid:

- **Denormalize `orgId` onto each child** and give it its own policy — simplest
  policy, one extra column per table, must be kept consistent on write.
- **Join-based policy** referencing the parent's `orgId` — no extra column, but
  the policy is a subquery and costs a join per check.

The denormalized approach is usually worth it for hot paths (messages, chunks).

### Admin-authored global config — shared, do NOT scope by default

These carry `createdBy`, but it is **provenance** (which admin authored the
config), not a tenant boundary. They are platform configuration shared across
all tenants:

`AiProviderConfig`, `AiProviderModel`, `AiCapability`, `AiAgentProfile`,
`AiAgentCapability`, `FeatureFlag`, `KnowledgeTag`, `AiOrchestrationSettings`
(singleton), `McpServerConfig` (singleton).

Leaving these global is the right default. A fork **may** decide some should be
tenant-scoped (e.g. per-org provider API keys) — that is a deliberate product
decision, not a mechanical `orgId` sweep. Treat each as opt-in.

Two of them are not columns you can add an `orgId` to at all:
`AiOrchestrationSettings` and `McpServerConfig` are singletons
(`slug @unique @default("global")`) whose every reader — and every process
cache — is written on "there is exactly one row". And `AiProviderConfig` keys
its credential off `apiKeyEnvVar`, the _name_ of a process environment
variable, which has no per-tenant form. Before scoping either, read
[`multi-tenancy-research.md` §5C](./multi-tenancy-research.md#5c-provider-credentials-and-per-tenant-ai-configuration)
— it compares six credential models and names the platform-tier seams
(credential resolver, cache/breaker re-keying) that keep them reachable.

### System / cross-tenant — no tenant owner

`User` (gets tenancy via the additive `Org` + `OrgMembership` join, not an
`orgId` column), `ContactSubmission` (public form), `DataErasureReceipt` and
`McpAuditLog` and `AiAdminAuditLog` (audit — the `userId` is the actor, retained
deliberately), `SeedHistory`, `Verification`.

## The retrofit recipe

1. **Add tenancy tables** — `Org` and `OrgMembership` (join `User` ↔ `Org` with
   a role). Put the active org id in the session (better-auth supports custom
   session fields). This is purely additive — existing single-tenant rows are
   unaffected. **Fork placement:** your own schema file, never a core one.
   **Two obligations `CLAUDE.md` imposes on any new model with a `userId` FK**
   apply here: declare an explicit `onDelete` (`Cascade` for `OrgMembership`,
   which is personal data; `SetNull` for anything you retain as audit) — the
   default is `Restrict`, which silently breaks GDPR erasure — and give the model
   an export disposition. Core models go in `SUBJECT_DATA_SOURCES`; **your** models
   go in `collectAppSubjectData` (`lib/app/data-export.ts`), which
   `exportUserData()` already folds into the export bundle.
2. **Add `orgId`** to each tenant-owned model from the inventory, backfill
   existing rows to a default org, then make it `NOT NULL`. Decide
   denormalize-vs-join for child rows. This is the step that edits **core**
   schema files, so keep the diff mechanical — one `orgId` field plus one
   `@@index` per model and nothing else — and the sync conflict stays a
   two-minute "keep both" instead of a re-read of upstream's model changes.
   Composite uniques (`@@unique([orgId, slug])`) ride the same migration.
3. **Create a non-superuser application role.** The app connects as a role with
   **no** `BYPASSRLS`. Migrations and seeds connect as a separate privileged
   role (see the bypass note in [Gotchas](#gotchas)). This split is the whole
   point — a role that bypasses RLS defeats it. The split is by **execution
   context**, not by two Prisma datasources: the running app gets the restricted
   role in `DATABASE_URL`, while `db:migrate:*` and `db:seed` run with
   `DATABASE_URL` pointing at the privileged role. Declare the second DSN as a
   fork env var through `appEnvSchema` (`lib/app/env.ts`) so it is validated and
   documented rather than passed ad hoc in a deploy script.
4. **Enable RLS + policies** on each owned table (pattern below). RLS via a raw
   migration; Prisma does not model policies, so this lives in a hand-written
   migration alongside your existing pgvector index migrations. Because Prisma
   cannot model them, policies are **Prisma-unmodelled objects** in the same
   class as those pgvector indexes — `prisma migrate dev` emits `DROP` for
   objects it cannot represent. Register a drift probe per policy in the same
   change ([below](#keeping-the-retrofit-alive-across-upstream-syncs)); without
   one, a routine `migrate dev` leaves a green test suite over an unprotected
   database.
5. **Wrap the client** so every tenant-scoped request runs inside a
   `$transaction` that first sets `app.current_org` with `SET LOCAL` (pattern
   below). Replace the `TENANCY_MODE=multi` guard in `lib/db/client.ts` with
   this wrapper — the one core edit upstream sanctions. `withOrg` needs an
   `orgId` from somewhere, and **there is no ambient tenant context in the
   codebase**: see
   [research §5A.1](./multi-tenancy-research.md#5a1-the-prerequisite-there-is-no-tenant-context-to-pass)
   before assuming route handlers can just pass one down and background jobs
   will sort themselves out.
6. **Delete the seam guard** and flip `TENANCY_MODE=multi`.

## The proven RLS pattern

### Policy (per owned table)

```sql
ALTER TABLE "AiConversation" ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON "AiConversation"
  USING ("orgId" = NULLIF(current_setting('app.current_org', true), '')::uuid);
```

- `current_setting('app.current_org', true)` — the `true` is `missing_ok`: it
  returns `NULL` instead of erroring when the GUC was never set.
- `NULLIF(..., '')` — **load-bearing, do not drop it.** Once any `SET LOCAL`
  touches this custom GUC on a pooled connection, it reverts to an **empty
  string** after the transaction, not to unset. Without `NULLIF`, the next
  unscoped query on that recycled connection crashes casting `''::uuid`
  (`invalid input syntax for type uuid: ""`) instead of cleanly returning zero
  rows. The spike below caught exactly this.

### Setting the tenant context — per transaction, never per session

```typescript
// The wrapper a fork adds in lib/db/client.ts. Every tenant-scoped call runs
// through this; the SET LOCAL is scoped to the transaction and cannot outlive it.
export async function withOrg<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // parameterized — never string-interpolate the org id
    await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, true)`;
    return fn(tx);
  });
}
```

`set_config(..., true)` is the function form of `SET LOCAL` (the trailing
`true` = local to the transaction). Use it with a tagged template so the org id
is bound, not interpolated.

> **Why per-transaction and not per-session?** The `pg` pool recycles physical
> connections between requests. A session-level `SET` persists on the connection
> after it is returned to the pool, so the **next** request to borrow that
> connection inherits the previous tenant's context — a cross-tenant data leak.
> `SET LOCAL` / `set_config(...,true)` is bound to the transaction and released
> at `COMMIT`/`ROLLBACK`, so nothing leaks onto the recycled connection.

### The proof (runnable)

[`scripts/spikes/rls-isolation-spike.mjs`](../../scripts/spikes/rls-isolation-spike.mjs)
is a standalone, throwaway script (no migration, not wired into the app) that
demonstrates all of the above against real Postgres. Run it:

```bash
# against a throwaway container
docker run -d --name sunrise-rls-spike -e POSTGRES_PASSWORD=postgres -p 5433:5432 pgvector/pgvector:pg15
node scripts/spikes/rls-isolation-spike.mjs

# or against any throwaway database via env override
SPIKE_ADMIN_URL=postgresql://me@localhost:5432/rls_spike \
SPIKE_APP_URL=postgresql://app_user:app_pw@localhost:5432/rls_spike \
node scripts/spikes/rls-isolation-spike.mjs
```

Verified output:

```text
=== (d) BYPASS PATH: superuser sees every row (migrations/seed) ===
    superuser sees: [ 'A-secret-1', 'A-secret-2', 'B-secret-1' ] (3 rows)

=== (a) FAILURE: session-level SET leaks across a pooled connection ===
    req#1  SET session org=A           -> app_user sees: [ 'A-secret-1', 'A-secret-2' ]
    req#2  NO set (different "tenant")  -> reused conn sees: [ 'A-secret-1', 'A-secret-2' ]
    >>> LEAK: request #2 read tenant A data it never scoped to.

=== (b)+(c) FIX: SET LOCAL per-transaction — no leak, raw query still scoped ===
    req#1  BEGIN; SET LOCAL org=B; raw SELECT -> sees: [ 'B-secret-1' ]
    req#2  NO set (different "tenant")         -> reused conn sees: []
    >>> NO LEAK: SET LOCAL did not survive the transaction.
```

The FIX block's `req#1` uses a raw `SELECT` — the same shape as the
`$queryRawUnsafe` pgvector search in `knowledge/search.ts` — and it obeys the
policy with no app-layer filter. That is the case app-layer scoping can't cover.

## Gotchas

- **Per-transaction, not per-session** — the headline leak above. This is the
  single thing most RLS-on-pooled-Prisma attempts get wrong.
- **`NULLIF` on the GUC** — the empty-string-revert crash above. The naive
  `current_setting('app.current_org', true)::uuid` policy works in a first
  request and then crashes the second on a recycled connection.
- **Bypass role for migrations/seed/admin.** A superuser, or any role with
  `BYPASSRLS`, ignores policies entirely (the spike's "BYPASS PATH" proves it).
  Run migrations and seeds as that role; run the **app** as a role without it.
  Table owners also bypass their own RLS unless you `ALTER TABLE … FORCE ROW
LEVEL SECURITY`, so do not let the app role own the tenant tables.
- **PgBouncer in transaction mode.** Transaction-pooling poolers hand a
  different server connection per transaction, which is _compatible_ with the
  per-transaction `SET LOCAL` pattern (the SET and the queries share one
  transaction = one server connection). But a session-level `SET` would be even
  more broken behind PgBouncer than behind the `pg` pool. Stay per-transaction.
- **Connection-level GUC defaults don't help.** You cannot set `app.current_org`
  at connect time and rely on it — the pool's connections are shared. The org
  must be established inside the request's transaction every time.
- **Fork gotcha: registered app jobs arrive with no tenant.** `lib/app/jobs.ts`
  runs your job on the existing maintenance tick, and that tick has no org — so
  `withOrg` has nothing to read and a bare query sees zero rows (or, on a
  privileged role, everything). Iterate orgs explicitly inside the job and open
  one `withOrg` transaction per org. The path of least resistance is to run jobs
  on the bypass role; that silently undoes the isolation guarantee for the half
  of the system that runs unattended, and nothing detects it.
- **Per-tenant quotas: register a key resolver, don't fork the middleware.**
  `registerRateLimitKeyResolver('org', ...)` in `lib/app/rate-limit.ts` buckets
  requests by anything you can derive from the request, so an org-scoped _key_
  needs no edit to `lib/security/`. Derive the identifier from an authenticated
  principal, or from a value the resolver verifies — a caller who controls the
  identifier mints a fresh bucket per request and walks past the cap.
  Compositing with `getClientIP()` is not a substitute: it bounds who _shares_
  a bucket, not how many one caller can _mint_. See
  [rate limiting → custom keys](../security/rate-limiting.md).
- **Fork gotcha: a registry seam is only as open as its narrowest type.**
  The case above was this shape until 2026-09-01: `lib/app/rate-limit.ts` let
  you register org-scoped _rules_ while `RateLimitKey` stayed a closed union, so
  the seam looked open and the thing per-tenant quotas actually need was
  unreachable. That instance is fixed; the shape is not rare. Audit the other
  seams you plan to lean on for it before you commit to them
  ([research §8](./multi-tenancy-research.md#the-ratelimitkey-case-study)).

## Keeping the retrofit alive across upstream syncs

Your isolation boundary is correct against the release you built it on. Upstream
ships single-tenant and runs no policy tests, so any release can add a model, a
raw SQL site, a process-global cache or a background job that lands **outside**
the boundary — and nothing in the merge signals it. Treat the following as part
of merging a Sunrise release, alongside the migration reconciliation in
[`CUSTOMIZATION.md` §9](../../CUSTOMIZATION.md#9-staying-in-sync-with-upstream-sunrise).

**Per-sync checklist.** Four diffs and one test run:

```bash
# 1. New models — classify each against the inventory above before shipping
git diff <last-sync>..HEAD -- prisma/schema/ | grep -E '^\+model '

# 2. New raw SQL — each is a query only RLS can cover, no `where` clause reaches it
git diff <last-sync>..HEAD -- 'lib/**' | grep -nE '^\+.*\$(queryRaw|executeRaw)'

# 3. New process-global state — plane 3; RLS cannot see a Node heap at all
git diff <last-sync>..HEAD -- 'lib/**' | grep -nE '^\+.*(new (Map|Set)\(|globalThis)'

# 4. New background jobs — they run with no tenant context unless you give them one
git diff <last-sync>..HEAD -- lib/orchestration/maintenance/ lib/orchestration/scheduling/
```

Then run your two-tenant leakage harness. If you have not written one, write it
before the second sync — it is the only check that fails when one of the four
above is missed, and it is the cheapest thing on the list.

**Automate the part that can be automated.** Policies belong in the drift-probe
registry that already exists for the pgvector indexes: `lib/app/db-drift.ts` is
fork-owned scaffold, `registerAppDriftProbe()` accepts any
`Probe` (`() => Promise<{ ok, note? }>`), and `npm run db:drift-check` runs in CI
and in `/pre-pr`. [`lib/db/drift-probes.ts`](../../lib/db/drift-probes.ts) ships
`rlsEnabled(table)` and `policyExists(table, policy)` factories, so each
protected table is two one-liners — register **both**: a policy can exist while
RLS is disabled, and RLS can be enabled with the policy dropped.

```typescript
// lib/app/db-drift.ts — fork-owned scaffold, merges cleanly forever
registerAppDriftProbe({
  name: 'RLS enabled+forced on AiConversation',
  kind: 'RLS posture',
  table: 'AiConversation',
  probe: rlsEnabled('AiConversation'), // asserts ENABLE and FORCE; see its JSDoc to waive FORCE
});
registerAppDriftProbe({
  name: 'RLS org_isolation on AiConversation',
  kind: 'RLS policy',
  table: 'AiConversation',
  probe: policyExists('AiConversation', 'org_isolation'),
});
```

Better still, derive the list instead of hand-maintaining it: a test that parses
`prisma/schema/**` for models carrying `orgId` and asserts RLS is enabled with a
policy on each. That is the enforcement shape `CLAUDE.md` already mandates for
the privacy export manifest, it fails loudly, and it survives the author leaving
— which a checklist does not. See
[research §12](./multi-tenancy-research.md#12-documentation-drift).

## The `TENANCY_MODE` seam

[`lib/db/client.ts`](../../lib/db/client.ts) contains:

```typescript
if (env.TENANCY_MODE === 'multi') {
  throw new Error('TENANCY_MODE=multi is not implemented by the Sunrise template. …');
}
```

This is the documented extension point. A fork replaces the guard with the
`withOrg` wrapper (or equivalent) and exposes the tenant-scoped client, then
flips `TENANCY_MODE=multi`. Until that work is done the guard makes the failure
obvious instead of silent. See [`lib/env.ts`](../../lib/env.ts) for the env
declaration.

## Related

- [`multi-tenancy-research.md`](./multi-tenancy-research.md) — **the gap
  analysis around this playbook.** This document covers row isolation (the data
  plane) and covers it in build-ready detail. The research document maps the
  other four isolation planes — namespace, process, temporal, external — plus
  the control plane (#366/#367) and the commercial plane, and assigns each gap
  to platform-tier or fork-tier. Read it before scoping a retrofit; read this
  one when you are building it.
- [`.context/privacy/data-erasure.md`](../privacy/data-erasure.md) — the
  cascade/`SetNull` `onDelete` graph built for GDPR erasure **is** the
  org-delete dependency graph a fork needs for tearing down a tenant.
- [`multi-tenancy-research.md` §14](./multi-tenancy-research.md#14-the-recommendation)
  — **the position, rather than the analysis.** Start here if you want the
  short answer before the survey.
- [`multi-tenancy-research.md` §5A](./multi-tenancy-research.md#5a-topology-and-the-prerequisite-nobody-costed)
  — **read before starting this retrofit.** Two things this playbook assumes.
  First, a tenant context to scope by: there is no `AsyncLocalStorage` anywhere,
  so `withOrg(orgId, …)` has nowhere to get its `orgId` outside a route handler,
  and background jobs cannot get one at all. Second, that pooled-with-RLS is the
  right topology — a real three-way choice, not a default. **Schema-per-tenant
  reuses this playbook's per-transaction `set_config` discipline unchanged while
  removing plane 2, the `orgId` migration and the policy-coverage burden**; and
  a cell is what Sunrise already ships.
- [`multi-tenancy-research.md` §5B](./multi-tenancy-research.md#5b-data-handling-residency-and-storage-flexibility)
  — **read this before promising a tenant their own storage arrangement.** RLS
  covers rows in _this_ database; it says nothing about buckets, regions,
  customer-managed keys, a second database, or where inference happens. The
  section grades those as a six-rung ladder with an honest verdict on each, and
  points out that most such requests are really portability requests.
- [`.context/orchestration/retention.md`](../orchestration/retention.md) —
  retention/pruning is per-data-class today; a fork would scope it per-org.
- [`CUSTOMIZATION.md` §9](../../CUSTOMIZATION.md#9-staying-in-sync-with-upstream-sunrise)
  — how a fork merges a Sunrise release generally; the
  [sync checklist](#keeping-the-retrofit-alive-across-upstream-syncs) above is
  the tenancy-specific addition to it.
- [`multi-tenancy-research.md` §8](./multi-tenancy-research.md#8-downstream-fork-considerations)
  — **the fork contract.** The eighteen-file merge surface, the `lib/app/*` seams
  that absorb MT work today, the provisions upstream should ship to shrink that
  surface, and the seam-design principles to follow if you build one locally
  first.
- [`architecture/overview.md`](./overview.md) — the single-tenant baseline.
