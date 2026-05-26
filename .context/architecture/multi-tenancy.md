# Multi-Tenancy Playbook

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

The schema has **60 models**. Before adding `orgId` anywhere, classify them —
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

### System / cross-tenant — no tenant owner

`User` (gets tenancy via the additive `Org` + `OrgMembership` join, not an
`orgId` column), `ContactSubmission` (public form), `DataErasureReceipt` and
`McpAuditLog` and `AiAdminAuditLog` (audit — the `userId` is the actor, retained
deliberately), `SeedHistory`, `Verification`.

## The retrofit recipe

1. **Add tenancy tables** — `Org` and `OrgMembership` (join `User` ↔ `Org` with
   a role). Put the active org id in the session (better-auth supports custom
   session fields). This is purely additive — existing single-tenant rows are
   unaffected.
2. **Add `orgId`** to each tenant-owned model from the inventory, backfill
   existing rows to a default org, then make it `NOT NULL`. Decide
   denormalize-vs-join for child rows.
3. **Create a non-superuser application role.** The app connects as a role with
   **no** `BYPASSRLS`. Migrations and seeds connect as a separate privileged
   role (see the bypass note in [Gotchas](#gotchas)). This split is the whole
   point — a role that bypasses RLS defeats it.
4. **Enable RLS + policies** on each owned table (pattern below). RLS via a raw
   migration; Prisma does not model policies, so this lives in a hand-written
   migration alongside your existing pgvector index migrations.
5. **Wrap the client** so every tenant-scoped request runs inside a
   `$transaction` that first sets `app.current_org` with `SET LOCAL` (pattern
   below). Replace the `TENANCY_MODE=multi` guard in `lib/db/client.ts` with
   this wrapper.
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

- [`.context/privacy/data-erasure.md`](../privacy/data-erasure.md) — the
  cascade/`SetNull` `onDelete` graph built for GDPR erasure **is** the
  org-delete dependency graph a fork needs for tearing down a tenant.
- [`.context/orchestration/retention.md`](../orchestration/retention.md) —
  retention/pruning is per-data-class today; a fork would scope it per-org.
- [`architecture/overview.md`](./overview.md) — the single-tenant baseline.
