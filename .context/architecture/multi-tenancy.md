# Multi-Tenancy Playbook

> **Rewritten 2026-09-21 (§107 t-710) — from a retrofit recipe to an
> enablement guide.** Until row isolation shipped, this document told a fork
> how to _build_ RLS isolation itself: a hand-maintained model inventory, the
> proven policy, a six-step retrofit. That recipe is now what Sunrise ships and
> CI enforces, so the reader has changed. This page tells an **operator or fork
> how to enable the capability**, what a fork adds for its own models, what the
> tests catch versus what a release merge still has to check by hand, and the
> gotchas that survive. The decisions and architecture are the design record,
> [`multi-tenancy-design.md`](./multi-tenancy-design.md); where the two
> disagree, that document wins.
>
> **TL;DR — single-tenant by default, and that costs nothing.** Every install
> runs with one org (the install org) and every user a member of it. At
> `TENANCY_MODE=single` — the default — no policy is enforced, no
> `set_config` is ever issued, and the app connects as whatever role it always
> did. Nothing on this page applies to you unless you set `multi`.

## Who this is for

- **An operator turning on multi-tenancy** for one deployment — read
  [Enabling it, end to end](#enabling-it-end-to-end).
- **A fork with its own models** that must be an org's — read
  [What a fork adds](#what-a-fork-adds-for-its-own-models).
- **A fork merging a Sunrise release** with tenancy enabled — read
  [What the tests catch, and what a merge still checks](#what-the-tests-catch-and-what-a-merge-still-checks).
- **A fork splitting the admin console** between the vendor and a customer —
  read [The control plane](#the-control-plane-which-admin-surfaces-are-whose).

Not for: someone building the isolation mechanism (the design record and the
three `tenancy/` pages), or assessing whether multi-tenancy is the right
topology at all ([`multi-tenancy-research.md`](./multi-tenancy-research.md)
— cells, one deployment per customer, remain the answer to residency asks).

## What you get at `multi`, and what you do not yet

What is enforced, maintained and regression-tested upstream once the switch
is on:

- **Org identity and membership** — `Org` / `OrgMembership`, invitations
  into an org, an active org per session, the lifecycle API
  ([`tenancy/identity.md`](../tenancy/identity.md)).
- **Tenant context on every request** — the guards enter the org the session,
  API key, embed token, MCP key or resolver header names, and the data layer
  reads it below the handler
  ([`tenancy/context.md`](../tenancy/context.md)).
- **Row isolation in Postgres** — one `org_isolation` policy per tenant-owned
  table (42 today, child rows included), `USING` + `WITH CHECK`, enforced
  against the restricted app role; ORM queries and raw SQL obey it
  identically, and a forgotten path fails loud rather than reading wide
  ([`tenancy/isolation.md`](../tenancy/isolation.md)).
- **Per-org namespaces** — two orgs can each have an agent called `support`,
  a knowledge base called `policies`, the same uploaded file; routing keys an
  unauthenticated route resolves (`AiWorkflow.slug`, trigger channels,
  dedup keys) stay global by decision.
- **Org-level privacy** — `exportOrgData` / `eraseOrg` and the org manifest
  ([`privacy/`](../privacy/)).

What does **not** yet work at `multi`, honestly, because the features that
own it have not shipped (the Multi-tenancy phase on the Hub; the design
record's [target architecture](./multi-tenancy-design.md#target-architecture)
says which piece each feature lands):

- **Background work enters no org.** The maintenance tick's eight platform
  jobs (`lib/orchestration/maintenance/platform-jobs.ts`), the scheduler,
  retention and any job registered through `lib/app/jobs.ts` run with no
  tenant context. At `multi` a job's first operation on a tenant-owned table
  throws `No tenant context` — the tick contains and logs the failure and
  moves on, so nothing crashes and nothing reads wide, but **nothing runs
  either**. Tenant-aware jobs and caches are §108, which must ship in the same
  release as row isolation for exactly this reason.
- **The system agents are the install org's rows.** `cleanup-agent`,
  `mcp-system`, `quiz-master`, the evaluation judges, the model auditor and
  the case generator are seeded once, as the install org. Another org finds
  none of them: the cleanup upload reports the agent unseeded, an unscoped
  MCP call logs `mcp-system agent not found`, the quiz and judge routes 404.
  Whether they are seeded per org, made global, or gated is an open decision
  on §107's journal.
- **Process-global state is global.** Settings caches, circuit breakers, the
  in-flight counter, provider instance caches — RLS cannot see a Node heap
  (§108 declares a posture per cache).
- **Cross-org user erasure.** `eraseUser` / `exportUserData` enter no scope
  of their own; at `multi` they act inside whichever org the caller entered,
  so a user with memberships in several orgs is erased from — and exported
  from — one of them.
- **One admin console.** The authorization policy already distinguishes a
  platform admin from an org OWNER/ADMIN, but the console is not split; the
  [control-plane map](#the-control-plane-which-admin-surfaces-are-whose)
  below is what §111 splits along.
- **Storage, provider policy, quotas** — §109 / §110.

## Enabling it, end to end

Three things have to be true at once, and the order they become true in
matters: the app connects as a role that is subject to the policies; the
policies are enforced; the app knows to set the org on every operation.

### 1. The role split — required, not optional

A table's owner is never subject to its policies unless `FORCE` is on, and a
role with `BYPASSRLS` is never subject to them at all. On Neon the deploy
role (`neondb_owner`) **has `BYPASSRLS`**; locally the owner is usually
`postgres`, a superuser. An app connecting as either sees every row whatever
the policies say. So at `multi` there are two DSNs:

| Variable               | Role                                    | Used by                                                       |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`         | the app role — `LOGIN NOBYPASSRLS`      | the running app, `db:drift-check`, `smoke:tenancy-isolation`  |
| `MIGRATE_DATABASE_URL` | the owner (`postgres`, `neondb_owner`…) | `db:migrate:*`, `db:seed`, `db:tenancy:enable\|disable\|role` |

`MIGRATE_DATABASE_URL` falls back to `DATABASE_URL` when unset or blank —
the single-tenant shape. Create the app role **after** migrating (the script
refuses on a database with no `_prisma_migrations` table; the default
privileges it sets would otherwise grant the ledger):

```bash
npm run db:migrate:deploy                                   # as the owner; carries the dormant policies
TENANCY_APP_ROLE_PASSWORD=… npm run db:tenancy:role -- --create
```

The password comes only from the environment, never an argument; the role
name is `TENANCY_APP_ROLE` (default `sunrise_app`). The script grants
`USAGE` on the schema, DML on its tables and sequences, and default
privileges for tables future migrations create — never anything on
`_prisma_migrations` — and refuses to touch a superuser, a `BYPASSRLS` role,
a table owner or the role running it. `--drop` reverses it. Details:
[`isolation.md` → The role split](../tenancy/isolation.md#the-role-split).

### 2. Enforce the policies

```bash
MIGRATE_DATABASE_URL=<owner dsn> npm run db:tenancy:enable
```

The policies shipped dormant with the schema
(`20260920120000_org_isolation_policies`); this backfills every `NULL`
`orgId` to the install org (except a platform admin API key and detached
cost logs, whose `NULL` is the point), then `ENABLE` + `FORCE ROW LEVEL
SECURITY` on every tenant-owned table, derived from the generated client —
a fork's model is covered without registration. It refuses to enable a table
with no policy (RLS on with no policy is default-deny: an outage), reads the
flags back, and exits non-zero unless every table is in the requested state.
Idempotent; a second run prints "no change". `npm run db:tenancy:disable`
reverses both flags. The script is mode-agnostic — enabling at `single` is
pointless, and what you see depends on the role, because no setter is ever
issued at `single`: a superuser or a `BYPASSRLS` owner (a local `postgres`,
Neon's `neondb_owner`) is not subject to the policies and sees no symptom
at all (this repo's `docker-compose.yml` runs as `postgres`, so a Compose
developer sees nothing change); **any other role — including a plain
`NOBYPASSRLS` owner, the RDS master-user shape — is under `FORCE` and sees
zero rows and a `WITH CHECK` error on every write**. An accidental enable on that install
is an outage; `db:tenancy:disable` is the fix.

### 3. Flip the mode

Set, for the running app:

```bash
TENANCY_MODE=multi
DATABASE_URL=<app role dsn>
MIGRATE_DATABASE_URL=<owner dsn>
```

From here every operation on a tenant-owned model runs as
`$transaction([set_config('app.current_org', <org>, true), op])`, and an
operation that has no org throws before any SQL.

### 4. Prove it

```bash
TENANCY_MODE=multi npm run db:drift-check       # as the app role: 9 + 84 tenancy probes green
```

The T-series asserts every policy exists and RLS is enabled **and forced** on
every tenant-owned table; at `multi` RLS being off is the failure that reads
as healthy. Then, **against a throwaway database only** — it seeds and
deletes two orgs by prefix and refuses to run at `single`:

```bash
TENANCY_MODE=multi npm run smoke:tenancy-isolation
```

That is the two-org harness CI runs on every upstream PR as `smoke-multi`
([`ci.md`](./ci.md#smoke-multi--the-only-control-that-runs-a-policy-107-t-709)),
as the restricted role: two orgs with equivalent rows, and as A every read
path — the raw-SQL ones included — answers none of B's. It is the one control
that actually runs a policy; widening one to `USING (true)` fails 5 of its
checks and dropping one fails its first create.

### Orderings and re-runs

- **Migrate → role → enable.** The role script needs the ledger; the enable
  script needs the policies the migrations carry.
- **After `npm run db:reset`, run steps 1 and 2 again** —
  `db:tenancy:role -- --create` **and** `db:tenancy:enable`. The reset
  recreates the schema from the migrations: the role's grants go with it
  (the role itself survives — the app sees `permission denied for schema
public` until `--create` re-grants), and the policies come back
  **dormant** — so between re-running `--create` and re-running `enable`
  the app at `multi` is issuing `set_config` against tables with RLS off
  and sees every org's rows. Do both, in that order, before the app comes
  back. The reset's re-seed runs as the owner through
  `MIGRATE_DATABASE_URL`.
- **Seeding at `multi`** runs as the owner (`db:seed` reads
  `MIGRATE_DATABASE_URL`) and lands every built-in row as the install org's.
- **Turning it off — stop the app, then `db:tenancy:disable`, then
  restart at `single`.** Running `disable` while a live app is still at
  `multi` opens a window in which it issues `set_config` against dormant
  policies and serves every org's rows to whichever org asked. Restarting
  at `single` on the owner DSN _before_ `disable` closes that leak but, on
  a plain `NOBYPASSRLS` owner, is the fail-closed outage above until
  `disable` runs — acceptable only if you would rather be down than wide.
  The stamped `orgId` columns stay; nothing is lost.
- **Never `ALTER ROLE … SUPERUSER` / `BYPASSRLS`** on the app role, not even
  to say `NO`: mentioning either needs a superuser, and the role script never
  does.

## What a fork adds for its own models

A model of yours that is an org's joins the boundary by carrying the column,
in the exact shape every core model uses (a back-relation line on `Org` goes
with it):

```prisma
orgId String?
org   Org?    @relation(fields: [orgId], references: [id], onDelete: Cascade)

@@index([orgId])
@@map("app_your_table")   // every core table is snake_case; raw SQL and the policy name the mapped table
```

`Cascade` for data that is the org's; `SetNull` for a retained record
(`AiCostLog` is the one core case). That is the whole registration step —
injection, the setter, the drift probes, the enable script and the harness
all derive the tenant-owned set from the generated client. In particular,
**do not register `rlsEnabled` / `policyExists` probes for it** in
`lib/app/db-drift.ts`: `db:drift-check` already derives them for every
tenant-owned table (`policyExists` in both modes, `rlsEnabled` at `multi`);
those two factories are for RLS you hand-roll on a table outside that set. What remains is what the tests will name until you do it:

| The test that names your model                        | What it wants                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/lib/tenancy/model-classification.test.ts` | Every model is tenant-owned (has `orgId`), on `SYSTEM_MODELS`, or on `GLOBAL_CONFIG_MODELS` (`lib/tenancy/classification.ts`). An unclassified model fails the build. **Never delete from an allowlist to go green** — move deliberately, column change in the same PR.                                                                                                                                                                   |
| `tests/unit/lib/tenancy/policy-coverage.test.ts`      | Every tenant-owned table has exactly one `org_isolation` policy. Append `orgIsolationPolicySql('<table>')` from `lib/tenancy/isolation.ts` to a **new** migration of yours; never edit one that shipped.                                                                                                                                                                                                                                  |
| `tests/unit/lib/privacy/org-sources.test.ts`          | Every `orgId` model has a disposition in `lib/privacy/org-sources.ts` — what an org receives from it in `exportOrgData`, or why it is excluded. Never delete a row to pass. **This is a core file, and the one edit a fork cannot avoid today**: the org manifest has no fork seam yet (the subject manifest's `registerAppSubjectSources()` is the shape §109 gives it).                                                                 |
| `tests/unit/lib/tenancy/org-scoped-slugs.test.ts`     | A tenant-owned model's human-meaningful slug is `@@unique([orgId, slug])`, not a global `@unique`. A routing key that must stay global is an explicit exception in the test, with its reason.                                                                                                                                                                                                                                             |
| `tests/unit/db-raw-sql-allowlist.test.ts`             | Every `$queryRaw*` / `$executeRaw*` site under `lib/**` and `app/**` is listed (`scripts/**` and migrations are deliberately outside it — they run as the operator's own role, where RLS is not the control). A raw `INSERT` on a tenant-owned table must stamp `orgId` itself — read it off the parent row in the same statement, `(SELECT "orgId" FROM <parent> WHERE id = $1)`, the way the message embedder and the chunk writers do. |

Two more things the tests cannot ask for:

- **A global-config model you decide to scope** (per-org provider keys, say)
  is a product decision: add the column and remove it from
  `GLOBAL_CONFIG_MODELS` in the same change. The two singletons
  (`AiOrchestrationSettings`, `McpServerConfig`) cannot take an `orgId` at
  all.
- **An unauthenticated route that names a row** (a signed token, a webhook
  slug) has no org until it reads the row. Read that one row under
  `runAsCredentialLookup`, pass its `orgId` and org status through
  `resolveCredentialOrg`, and run everything else inside `runAsOrg` — the
  shape the inbound route and the HMAC approval routes use
  ([`context.md`](../tenancy/context.md#who-enters-it--the-read-rule)). A
  route that skips this throws at `multi`, which is the design.

Where the code lives is unchanged from the fork tiers: your models in your
schema file (`prisma/schema/app.prisma`, or a `framework-*.prisma` file for a
framework fork), your migrations in your own folders, your jobs through
`lib/app/jobs.ts`, your subject-export dispositions through
`lib/app/data-export.ts`, a subdomain or path scheme through
`lib/app/tenant-resolver.ts`
([`CUSTOMIZATION.md`](../../CUSTOMIZATION.md#the-appplatform-model)). The
org-export manifest above is the one core file a tenant-owned model of yours
touches until §109 opens it.

## What the tests catch, and what a merge still checks

A Sunrise release can land code outside your isolation boundary, and the
merge itself never says so. Most of that is now a build failure, upstream
and in your fork:

| Change in a release                                                  | Caught by                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A new model nobody classified                                        | `model-classification.test.ts`                                                                                |
| A tenant-owned table without a policy; `migrate dev` dropping one    | `policy-coverage.test.ts`; the T-series in `db:drift-check`                                                   |
| A new raw-SQL site                                                   | `db-raw-sql-allowlist.test.ts` (it must be admitted; whether it stamps or scopes correctly is the reviewer's) |
| A global slug on a tenant-owned model                                | `org-scoped-slugs.test.ts`                                                                                    |
| A model missing from the org export                                  | `org-sources.test.ts`                                                                                         |
| A create shape the injection misses; a transaction the setter misses | `tests/unit/lib/db/tenancy-extension.test.ts` (real client, recording driver)                                 |
| Anything the above miss that a real policy would refuse              | `smoke-multi` on every upstream PR — the harness as the restricted role                                       |

What is **not** enforced, and is the per-sync check that remains until §108
ships its posture declarations:

```bash
# 1. New process-global state — RLS cannot see a Node heap; is the cache keyed by org, or global by decision?
git diff <last-sync>..HEAD -- 'lib/**' | grep -nE '^\+.*(new (Map|Set)\(|globalThis)'

# 2. New background jobs — they enter no org unless something gives them one
git diff <last-sync>..HEAD -- lib/orchestration/maintenance/ lib/orchestration/scheduling/
```

Then run the harness at `multi` against a throwaway database. An unmodified
fork gets `smoke-multi` for free — the job's `env` carries the role name,
the password and both DSNs, none of them secrets. A fork that sets
`CI_TEST_SCOPE=changed` should confirm the job still runs on its PRs
([`ci.md`](./ci.md)).

## Gotchas that survive

Each of these was measured, not reasoned; the register in the design record
has the numbers.

- **`NULLIF` on the GUC is load-bearing.** A custom GUC a `SET LOCAL` once
  touched reverts to the **empty string** on a pooled connection, not to
  unset. The policy compares against
  `NULLIF(current_setting('app.current_org', true), '')`, so a query that
  forgot the setter sees **nothing** — never a cast error, never everything.
  The spike below is what caught it.
- **Per transaction, never per session.** A session-level `SET` persists on
  the pooled connection and the next borrower inherits the previous tenant.
  The chokepoint issues `set_config(…, true)` inside a transaction on every
  operation; **do not hand-roll a `SET app.current_org` in raw SQL**. A
  transaction pooler (PgBouncer, Neon's pooler) is compatible with this —
  the setter and the operation share one transaction, so one server
  connection.
- **`FORCE` and the owner.** Under `FORCE ROW LEVEL SECURITY` the table
  owner is subject to the policies too. A data migration that touches
  tenant-owned rows as a `NOBYPASSRLS` owner would otherwise update zero
  rows and report success — so it opens with
  `SELECT set_config('app.bypass_rls', 'on', true)`; Prisma runs each
  migration in one transaction, so the first statement covers the rest.
- **The bypass is total.** `runAsSystem(reason)` sets `app.bypass_rls` and
  sees every org's rows; it is logged at `info` per entry so the audit can
  count them. `runAsCredentialLookup` is the same bypass for one credential
  read, logged at `debug`. Nothing else should run inside either.
- **Nested creates are stamped; raw inserts are not.** The injection walks
  every write and stamps create-shaped nodes at any depth. A raw `INSERT`
  stamps itself from the parent row (above). An update payload is never
  stamped — that would move a row between orgs wherever RLS is not
  enforcing.
- **`NULL` `orgId` rows belong to no org.** After enable the only ones left
  are platform admin API keys and detached cost logs; both are visible to
  `runAsSystem` and to no org. A row created under `runAsSystem` without an
  explicit `orgId` is another — it is outside every org and every namespace
  (Postgres treats `NULL`s as distinct in a unique index).
- **Enabling at `single` has no useful outcome.** The chokepoint issues no
  setter there: a superuser or `BYPASSRLS` owner is not subject to the
  policies and sees everything with no symptom; every other role — a
  restricted app role, or a plain `NOBYPASSRLS` owner under `FORCE` — sees
  zero rows and fails every write. Enable only with `multi`, and check with
  `TENANCY_MODE=multi npm run db:drift-check` rather than by looking at the
  app.
- **Neon's deploy role bypasses RLS.** `neondb_owner` inherits `BYPASSRLS`
  from `neon_superuser`; it is the owner DSN, never the app's. Neon also
  refuses `DROP OWNED BY`, which is why `--drop` revokes grants first.
- **Registered app jobs arrive with no tenant** — today, at `multi`, they
  fail loud (above). When §108 lands the seam gains a `scope` declaration;
  until then a job of yours that must run at `multi` iterates `forEachOrg`
  itself and never reaches for `runAsSystem` as the path of least
  resistance. Two things `forEachOrg` does that a job must want: it
  **skips suspended orgs** silently (nothing should act for an org that has
  been switched off — so a sweep that must reach them is a `runAsSystem`
  job, audited), and it runs the orgs **sequentially**, one scope at a time
  (per-org caps are meaningless if every org runs at once; map over the ids
  yourself if you need concurrency).
- **Per-tenant quotas: register a key resolver, don't fork the middleware.**
  `registerRateLimitKeyResolver('org', …)` in `lib/app/rate-limit.ts`
  buckets by anything derivable from the request; derive the identifier from
  an authenticated principal, never from a value the caller controls
  ([rate limiting → custom keys](../security/rate-limiting.md)).

## The control plane: which admin surfaces are whose

Everything above is the **data** plane — which rows exist for whom. This
section is the **control** plane: which _admin surfaces_ a customer runs and
which stay the vendor's. It stays on this page because its reader is the
same fork that enables the capability and then has to decide what a customer
sees; §111 is the platform work that splits the console along it, and until
then this is the map.

**The rule, so the table below does not have to be maintained to stay true:**

> A surface belongs to whichever plane its **backing models** sit in, per
> `lib/tenancy/classification.ts`. Tenant-owned models ⇒ the customer's
> surface. `GLOBAL_CONFIG_MODELS` and `SYSTEM_MODELS` ⇒ platform-ops. Where a
> page reads both, it needs splitting, not assigning.

The mapping is _almost_ 1:1 with the classification, and the "almost" is the
part worth reading. The table is a **worked application of the rule against
68 admin pages, not an enumeration to keep in sync** — where they disagree,
the rule and the classification win.

### Platform-ops — the vendor's

| Surface                                                      | Backing models                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `orchestration/providers`, `orchestration/provider-models`   | `AiProviderConfig`, `AiProviderModel`                              |
| `orchestration/capabilities`                                 | `AiCapability`                                                     |
| `orchestration/agent-profiles`                               | `AiAgentProfile`                                                   |
| `features` (feature flags)                                   | `FeatureFlag`                                                      |
| `orchestration/knowledge/tags`                               | `KnowledgeTag`                                                     |
| `orchestration/settings`, `orchestration/mcp/settings`       | The two singletons                                                 |
| `orchestration/mcp/tools`, `mcp/resources`                   | `McpExposedTool`, `McpExposedResource`                             |
| `users`, `users/[id]`, `users/invite`                        | `User` — tenancy arrives via the `Org` join, not an `orgId` column |
| `/api/v1/admin/orgs` (API only; no page yet)                 | `Org` — the vendor's acts: create, suspend, export, delete         |
| `logs`, `orchestration/audit-log`, `orchestration/mcp/audit` | Audit models — the actor is retained deliberately                  |
| `orchestration/learn`                                        | Static content, no data                                            |

Credentials are the hard stop, not a preference: `AiProviderConfig` keys its
credential off `apiKeyEnvVar` — the _name_ of a process environment variable
— which has no per-tenant form. Design decision Q3 keeps every model in this
group global in v1, with one consequence worth restating: **one embedding
model per install**, because vector dimension is a schema property.

### The customer's

| Surface                                             | Backing models                                        |
| --------------------------------------------------- | ----------------------------------------------------- |
| `orchestration/agents` (+ `new`, `[id]`, `compare`) | `AiAgent`, `AiAgentVersion`, the token models         |
| `orchestration/workflows`                           | `AiWorkflow`, `AiWorkflowVersion`                     |
| `orchestration/triggers`                            | `AiWorkflowTrigger`, `AiWorkflowSchedule`             |
| `orchestration/knowledge`                           | `AiKnowledgeDocument`, `AiKnowledgeBase`              |
| `orchestration/conversations`                       | `AiConversation`                                      |
| `orchestration/evaluations` (+ `datasets`, `runs`)  | `AiEvaluationSession`, `AiDataset`, `AiEvaluationRun` |
| `orchestration/experiments`                         | `AiExperiment`                                        |
| `orchestration/event-subscriptions` (+ `dlq`)       | `AiWebhookSubscription`, `AiEventHook`                |
| `orchestration/mcp/keys`                            | `McpApiKey`                                           |
| `orchestration/approvals`                           | Approvals on executions                               |

### Mixed — these need splitting, not assigning

This is the "almost" in "almost 1:1", and skipping it is how a fork ships a
customer console that leaks an aggregate.

- **`orchestration` (dashboard) and `overview`** — headline counts over both
  planes. Split the query, not the page.
- **`orchestration/costs`** — the _settings_ are the global singleton
  (platform-ops); the _spend_ is `AiCostLog`, per-tenant (`orgId`, `SetNull`
  on org erasure so the vendor's billing record survives the tenant).
- **`orchestration/analytics`** — topics, unanswered questions, engagement
  and content gaps are all derived from `AiConversation`. Tenant data
  presented as a global roll-up: the _page_ is a customer's, the vendor's
  version of it is a different query.
- **`orchestration/executions`** — the one that looks cleanly splittable and
  is not. `app/admin/orchestration/executions/page.tsx` fans three reads —
  `getExecutions()` (`AiWorkflowExecution`, the customer's),
  `getInitialSnapshot()` (live-engine lease state, process-global) and
  `getOrchestrationSettings()` (the global singleton, for the stuck-step
  threshold) — and renders the live-engine dashboard **above** the table on
  the same page. `executions/live` is a deeper view of the same platform-ops
  data, not a separable surface.
- **`orchestration/mcp/prompts`** — looks like a customer's, and is not one.
  `McpExposedPrompt` is on `GLOBAL_CONFIG_MODELS`: its `createdBy` is
  provenance, `prompt-registry.ts` serves every enabled row from a
  process-global cache to every MCP client, `name` is unique across the
  install, and the enabled cap is global. Shipping this page in a customer
  console publishes one tenant's prompt to all of them. Assign it to the
  customer only after scoping the model (column, `@@unique([orgId, name])`,
  per-org cache key and cap).
- **`orchestration/mcp` (landing) and `mcp/sessions`** — sit above both
  halves of the MCP split.

### Why the URL tree is not the answer

The obvious implementation — gate `app/admin/*` by prefix — does not work,
and `orchestration/mcp/*` is the proof: `keys` is a customer's, `tools`,
`resources` and `settings` are the vendor's, and `prompts` is neither until
the model behind it is scoped — three answers inside one nav section. Route
the decision through the authorization policy
([`.context/auth/authorization.md`](../auth/authorization.md)) with a `tier`
input, and let each surface answer for itself.

### The within-tenant axis

This section splits surfaces between the **vendor and the customer**.
Splitting rows _within_ one customer — one leader sees only the
questionnaires they created — is the orthogonal ownership axis (#367),
enforced in the application by `subjectScope` / `canRead`, not by RLS; its
data-layer form is §115. The distinction matters because the enforcement
differs in kind: a query that forgets its org context **throws** at `multi`
before any SQL (and if anything ever reached Postgres without the setter,
the policies would answer zero rows), while a query that forgets its owner
filter returns **everyone's in the org**. See
[the leak, stated plainly](../auth/authorization.md#the-leak-stated-plainly).

## The proof (runnable)

[`scripts/spikes/rls-isolation-spike.mjs`](../../scripts/spikes/rls-isolation-spike.mjs)
is the original, standalone spike — bare `pg`, one table, no migration, not
wired into the app — that established the two rules the shipped policy is
built on: per-transaction scoping, and `NULLIF` on the GUC. It is kept
runnable because it is the shortest demonstration of the leak that exists:

```bash
# against a throwaway container (NEVER the dev or production database)
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
policy with no app-layer filter. That is the case app-layer scoping cannot
cover, and why the capability is RLS-based.

**How the shipped shape differs from the spike**, so the output above is not
read as the current policy: the real `org_isolation` policy has a **bypass
arm** (`current_setting('app.bypass_rls', true) = 'on'`) and a `WITH CHECK`
clause, compares `orgId` as text (ids are cuids, not uuids), and is
enforced with `FORCE`. The second spike — `rls-chokepoint-spike.ts`, run
with the real generated client against a migrated database — is what
settled the chokepoint's shape (transactions, raw SQL, nested creates, the
pooler, `FORCE` versus the migrate role, the derived roster); its findings
are the [Spike register](./multi-tenancy-design.md#spike-register), and the
two-org harness `scripts/smoke/tenancy-isolation.ts` is what has replaced
both as the standing proof.

## Related

- [`.context/tenancy/isolation.md`](../tenancy/isolation.md) — the policy,
  the switch, the role split, the drift probes; the reference this page
  summarises.
- [`.context/tenancy/context.md`](../tenancy/context.md) — who enters the
  org, the read rule, `runAsSystem` / `runAsCredentialLookup` / `forEachOrg`,
  the data layer.
- [`.context/tenancy/identity.md`](../tenancy/identity.md) — `Org` /
  `OrgMembership`, the install-org invariant, credentials, what a fork may
  add to the org model.
- [`multi-tenancy-design.md`](./multi-tenancy-design.md) — the decisions,
  principles, target architecture and the spike register; what a fork gets
  and owns; merge impact.
- [`multi-tenancy-research.md`](./multi-tenancy-research.md) — the gap
  analysis: five isolation planes, the topology choice, residency and
  provider-credential asks, the fork contract.
- [`.context/auth/authorization.md`](../auth/authorization.md) — the policy
  the control-plane split routes through; the within-tenant ownership axis.
- [`.context/architecture/ci.md`](./ci.md#smoke-multi--the-only-control-that-runs-a-policy-107-t-709)
  — the `smoke-multi` job step by step, and what a fork must supply.
- [`.context/privacy/data-erasure.md`](../privacy/data-erasure.md) — the
  cascade graph `eraseOrg` relies on.
- [`CUSTOMIZATION.md` §9](../../CUSTOMIZATION.md#9-staying-in-sync-with-upstream-sunrise)
  — merging a Sunrise release generally; the two greps above are the
  tenancy-specific addition.
