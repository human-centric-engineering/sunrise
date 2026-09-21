# Tenancy: Row Isolation

The database side of multi-tenancy (§107 t-707): the `org_isolation`
policies every tenant-owned table carries, the switch that makes Postgres
consult them, the role split that makes the policies mean anything, and the
drift probes that notice when one goes missing. The application side — which
org a query runs for, and how the setter reaches Postgres — is
[`context.md`](./context.md#the-data-layer--libdbtenancy-extensionts); the
column the policies read is [`identity.md`](./identity.md); the design record
with the measurements behind each rule is the Spike register in
[`multi-tenancy-design.md`](../architecture/multi-tenancy-design.md#spike-register).

**At `TENANCY_MODE=single` none of this is active**, and that is by
construction rather than by branch: the policies exist but are dormant, no
GUC is ever set, and the app connects as whatever role it always did. A
single-tenant install pays nothing and changes nothing.

## The policy

One policy per tenant-owned table, named `org_isolation`, both clauses the
same predicate:

```sql
CREATE POLICY "org_isolation" ON "ai_agent"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "orgId" = NULLIF(current_setting('app.current_org', true), '')
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "orgId" = NULLIF(current_setting('app.current_org', true), '')
  );
```

- **`USING`** filters every read, update and delete to the current org's
  rows; **`WITH CHECK`** refuses an insert or update whose row would not be
  the current org's — a nested create that arrived without an `orgId`, or a
  row being moved to another org, fails with `42501` (`P2039` through
  Prisma) and the statement it was part of rolls back.
- **`NULLIF` is load-bearing.** An unset GUC reads as the empty string, and
  `"orgId" = ''` is false for every row — but so is `"orgId" = NULL`, and
  `NULLIF` is what turns the one into the other without a special case. A
  query that forgot the setter sees **nothing**, never everything. The
  playbook's runnable proof is what caught this.
- **The bypass arm** is what [`runAsSystem`](./context.md) sets
  (`set_config('app.bypass_rls', 'on', true)`, transaction-local) and what a
  data migration under `FORCE` needs: a `NOBYPASSRLS` table owner otherwise
  updates zero rows and reports success (Spike register item 7). It is a GUC
  rather than a second role by a §107 decision (item 9): one client, one
  pool, and the arm has to exist for migrations regardless.
- `NULL` `orgId` rows match no org. `db:tenancy:enable` backfills them to the
  install org before enforcing, so a row born before the chokepoint stamped
  the column, or written under `runAsSystem`, does not vanish.

The text is defined once, in
[`lib/tenancy/isolation.ts`](../../lib/tenancy/isolation.ts)
(`orgIsolationPolicySql`), and the migration carries it verbatim —
[`policy-coverage.test.ts`](../../tests/unit/lib/tenancy/policy-coverage.test.ts)
checks both the text and the coverage.

## Dormant with the schema

The policies ship in
`prisma/migrations/20260920120000_org_isolation_policies/migration.sql` —
a raw-SQL migration, the pgvector-index precedent — **without**
`ENABLE ROW LEVEL SECURITY`. `CREATE POLICY` on a table that has not been
enabled is inert for every role (item 4): every row visible, a `NULL`-org
insert accepted. So the policies version with the schema — a fork's
`migrate deploy` carries them, a `db:reset` recreates them — while the
switch below is the only thing that changes what Postgres does.

Prisma cannot model policies. `prisma migrate diff` from the database to the
schema does not mention them (it emits only the known unmodelled-index
drops), so they neither appear in nor are dropped by `migrate dev`; the
drift probes are what notices a missing one.

**A tenant-owned model needs a policy the moment it carries `orgId`.**
[`policy-coverage.test.ts`](../../tests/unit/lib/tenancy/policy-coverage.test.ts)
parses the migration and the roster the generated client derives, and fails
naming any tenant-owned table without exactly one `org_isolation` policy —
and any other table with one. When it names your model, append
`orgIsolationPolicySql('<table>')` to a **new** migration; never edit one
that has shipped.

## The switch — `db:tenancy:enable` / `db:tenancy:disable`

```bash
npm run db:tenancy:enable     # ENABLE + FORCE ROW LEVEL SECURITY, after the NULL backfill
npm run db:tenancy:disable    # DISABLE + NO FORCE — both
```

One script ([`scripts/db/tenancy-enable.ts`](../../scripts/db/tenancy-enable.ts)),
one transaction, every tenant-owned table — derived from the generated
client's runtime data model, so a fork's model is covered without
registration. What it does:

1. Sets the bypass GUC for its own transaction (the migrate role may be a
   `NOBYPASSRLS` owner; under `FORCE` it would otherwise see nothing).
2. Reads `pg_class.relrowsecurity` and `relforcerowsecurity` for every
   table.
3. **`enable`:** backfills `orgId IS NULL` rows to the install org on every
   table, then `ENABLE` / `FORCE` whichever flags are off. **`disable`:**
   `DISABLE` and `NO FORCE` whichever are on — the two flags are independent,
   and `DISABLE` alone leaves `FORCE` set (item 4).
4. Reads the flags back and refuses to report success unless every table
   is in the requested state.

**Idempotent by reading, not by assuming.** A table already in the requested
state gets no statement; a second run prints "no change". Exit codes: `0`
done or nothing to do; `1` the database did not reach the requested state;
`2` could not run (no DSN, connection refused, a table the migrations have
not created). Mode-agnostic: it does not read `TENANCY_MODE`. Enabling at
`single` is safe — the chokepoint issues no setter there, so the app would
see no rows, which is why you run it only when you mean it.

It connects with **`MIGRATE_DATABASE_URL`** when set, else `DATABASE_URL`:
`ALTER TABLE` needs the owner, and at `multi` `DATABASE_URL` is the
restricted role below.

## The role split

**Required, not optional.** A table's owner is never subject to its policies
unless `FORCE` is on, and a role with `BYPASSRLS` is never subject to them
at all. On Neon the deploy role (`neondb_owner`, via `neon_superuser`) is
not a superuser but **has `BYPASSRLS`**; locally the owner is usually
`postgres`, a superuser. An app connecting as either sees every row
whatever the policies say (item 7). So at `multi`:

| Connection             | Role                                    | Used by                                                         |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`         | the app role — `LOGIN NOBYPASSRLS`      | the running app (`lib/db/client.ts`), and so `db:drift-check`   |
| `MIGRATE_DATABASE_URL` | the owner (`postgres`, `neondb_owner`…) | `prisma migrate`, `db:seed`, `db:tenancy:enable\|disable\|role` |

`MIGRATE_DATABASE_URL` is optional and falls back to `DATABASE_URL`, which is
the single-tenant shape ([`prisma.config.ts`](../../prisma.config.ts) and
[`prisma/seed.ts`](../../prisma/seed.ts) read it; [`lib/env.ts`](../../lib/env.ts)
validates it). The seed runs through the chokepoint as the install org
(`runAsOrg(INSTALL_ORG_ID, …)` around `runSeeds`), so every built-in agent,
knowledge base, template and chunk lands as the install org's — measured
on a throwaway database with RLS forced: no `NULL`-org row on any seeded
table — and at `multi` it must run as the owner, since the app role does
not own the tables.

**Raw inserts stamp themselves.** A raw `INSERT` is the one create shape
the chokepoint cannot stamp. The three that write tenant-owned rows —
`ai_message_embedding` (`lib/orchestration/chat/message-embedder.ts`) and
`ai_knowledge_chunk` (`lib/orchestration/knowledge/seeder.ts`,
`document-manager.ts`) — read the org off the parent row in the same
statement (`(SELECT "orgId" FROM ai_message WHERE id = $1)`); at `multi` the
subselect sees only the current org's parent, so `WITH CHECK` holds. A new
raw insert on a tenant-owned table needs the same, and the raw-SQL
allowlist test is where that is decided. Migrations that touch
tenant-owned rows open with the bypass setter — Prisma runs each migration in
one transaction, so `SELECT set_config('app.bypass_rls', 'on', true)` as the
first statement covers the rest.

```bash
TENANCY_APP_ROLE_PASSWORD=… npm run db:tenancy:role -- --create
npm run db:tenancy:role -- --drop
```

[`scripts/db/tenancy-role.ts`](../../scripts/db/tenancy-role.ts) creates
the role (`TENANCY_APP_ROLE`, default `sunrise_app`) as
`LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE` with `USAGE` on the
current schema, `SELECT/INSERT/UPDATE/DELETE` on its tables, `USAGE/SELECT`
on its sequences — never anything on `_prisma_migrations`, which the app
does not touch and a compromised app role must not be able to forge — and
`ALTER DEFAULT PRIVILEGES` for the connecting owner so tables future
migrations create are covered. `--create` is idempotent (an existing role
has its password reset and grants re-applied); `--drop` revokes the default
privileges and every grant **first**, then drops the role — Neon refuses
`DROP OWNED BY`, and a role that still holds a grant cannot be dropped
anywhere. The password comes only from the environment, never an argument,
and is sent as a SCRAM-SHA-256 verifier computed locally
(`scramSha256Verifier`), so the cleartext never crosses the wire or lands in
a server's DDL log. The script refuses to touch the role running it, a
superuser, a `BYPASSRLS` role, or a table owner — `TENANCY_APP_ROLE=postgres`
would otherwise demote and re-password the operator's own login.

Then point `DATABASE_URL` at the new role, set `MIGRATE_DATABASE_URL` to the
owner's DSN, and set `TENANCY_MODE=multi`.

Two orderings to know. **Migrate first:** `--create` refuses on a database
with no `_prisma_migrations` table, because the default privileges it sets
would otherwise grant the ledger when the first `migrate deploy` creates
it. **Re-create after a reset:** `npm run db:reset` drops and recreates the
schema, and the role's `USAGE`, table grants and default privileges go with
it — the app then sees `permission denied for schema public` until
`--create` is run again (the role itself survives; the re-run re-grants).
A blank `MIGRATE_DATABASE_URL` counts as unset in every reader
(`ownerDsn()` in `lib/tenancy/isolation.ts`, `prisma.config.ts`).

## The drift probes — the T-series

`npm run db:drift-check` runs, beside the A-series, one probe per
tenant-owned table derived from the roster
(`tenancyDriftProbes` in [`lib/db/drift-probes.ts`](../../lib/db/drift-probes.ts)):

- `T<n> org_isolation on <table>` — `policyExists`, **always**. A dropped
  policy is a silent widening the moment RLS is enabled.
- `T<n>f RLS enabled + forced on <table>` — `rlsEnabled({ requireForced:
true })`, **at `TENANCY_MODE=multi` only**. There, RLS being off is the
  failure that reads as healthy: every query works and rows cross the
  boundary.

At `single` that is 9 + 42 probes; at `multi`, 9 + 84. Never a hand-written
row per table — `tests/unit/lib/db/drift-probes.test.ts` tests the
generator. The script runs its probes under `runAsSystem`: they are raw
catalog reads, and at `multi` the chokepoint refuses a raw op with no
context.

## Enabling, end to end

On a fresh or migrated database, as the owner:

```bash
npm run db:migrate:deploy                                  # carries the dormant policies
TENANCY_APP_ROLE_PASSWORD=… npm run db:tenancy:role -- --create
MIGRATE_DATABASE_URL=<owner dsn> npm run db:tenancy:enable
TENANCY_MODE=multi npm run db:drift-check                 # 84 tenancy probes green
```

Then run the app with `DATABASE_URL` as the app role and `TENANCY_MODE=multi`.
Measured on a throwaway database with the shipped client as that role: org A
sees only A's rows and B only B's, a system scope sees both, a cross-org
insert is refused by `WITH CHECK` (`42501`), a cross-org update finds no row,
and a plain connection with no GUC sees zero rows. The two-org harness and
CI job that keep this true are §107 t-709.

**Known gap until t-709:** the credential resolvers (`resolveApiKey`,
`resolveEmbedToken`, MCP key resolution) read a tenant-owned row to learn
the org they then enter, and the chokepoint refuses that read with no
context — see [`context.md`](./context.md#the-data-layer--libdbtenancy-extensionts).

## Proving it

- [`tests/unit/lib/tenancy/policy-coverage.test.ts`](../../tests/unit/lib/tenancy/policy-coverage.test.ts)
  — every tenant-owned table has exactly one policy and no other table any;
  the text is `orgIsolationPolicySql` verbatim with both arms in both
  clauses; shown to fire on a removed policy, an uncovered table, a stray
  policy.
- [`tests/unit/lib/tenancy/isolation.test.ts`](../../tests/unit/lib/tenancy/isolation.test.ts)
  — the plan over every flag state in both directions; the run's statement
  order (bypass GUC, backfill before any `ALTER`, never on disable), its
  idempotence, and its refusal when the flags do not read back.
- [`tests/unit/lib/db/drift-probes.test.ts`](../../tests/unit/lib/db/drift-probes.test.ts)
  — the T-series generator: per-mode counts, names, the catalogs each
  probe asks.
- [`tests/unit/scripts/db/`](../../tests/unit/scripts/db/) — the two
  scripts' shells: flags, DSN preference, one transaction with rollback,
  the statements the role script issues in order, exit codes.
- Against a real database: the enable → drift-check at `multi` → enable
  (no change) → disable → disable (no change) cycle on the dev DB, and the
  two-org run above on a throwaway container (§107 t-707 PR body).
