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
- **Background work per org** — every platform job in the maintenance tick,
  the schedules sweep and any job a fork registers through `lib/app/jobs.ts`
  declares a scope and runs once per active org inside that org's context
  (or once under the audited system scope, for the two audit tables that
  have no org); a tick fired from an admin's session sweeps every org, not
  the admin's ([`tenancy/context.md` → Background work](../tenancy/context.md#who-enters-it--the-read-rule),
  [`scheduling.md`](../orchestration/scheduling.md#unified-maintenance-tick-admin-auth-required-preferred)).
- **Sunrise's own agents and templates in every org** — each org gets its
  own instance of the platform's tenant-facing agents (`mcp-system`, the
  evaluation judges, the case generator and the clean-up agent), made when
  the org is created and kept current by a reconcile on each release, so a
  new org's MCP calls, evaluations, case generation and clean-up upload work
  with no manual step. They are defined in code: an org tunes how they run
  (provider, model, spend, rate limit, retention, and each capability
  binding's config and rate limit), and the API refuses edits to what the
  platform owns. `mcp-system`'s tools are the exception: which ones it may
  use is the org's choice. The workflow builder offers every org the
  built-in templates, served from code. See
  [platform agents](../orchestration/platform-agents.md).
- **Each org reaches only the AI providers it was approved for** (§120
  t-742). The install org may use every provider; every other org starts with
  none, and a platform admin grants providers, and optionally holds the org to
  jurisdictions, on the org's admin page (`/admin/orgs/[id]`) or with
  `PUT /api/v1/admin/orgs/[id]/providers`. Enforced on
  every vendor call core makes, whether the provider was auto-picked, named on
  the agent, a fallback, or an embedding or audio arm, and a fork's own
  eligibility rule can narrow it but never widen it. **Grant providers to each
  org you create after flipping the mode**, or its agents, workflows and
  knowledge base will refuse to call any vendor. See
  [LLM providers → Per-org approved providers](../orchestration/llm-providers.md#per-org-approved-providers-core-at-multi).
- **An org's configs cannot read the operator's env vars** (§111 t-811). At
  `multi`, an outbound call, auth secret or channel credential configured in
  a customer org may name only env vars under that org's `ORG_<ORG ID>_`
  prefix. Set a customer's credentials under its prefix. The install org
  names any. See
  [External calls](../orchestration/external-calls.md).
- **Each org can have its own monthly AI budget** (§110 t-788). A platform
  admin in the install org sets `settings.quotas.monthlyBudgetUsd` with
  `PATCH /api/v1/admin/orgs/[id]`, or a fork's billing code calls
  `writeOrgQuotas()`. An org's own admins cannot change it, and every change
  is in the admin audit log. Every paid AI call made in the org is held to it
  (the provider manager's spend gate): a chat turn ends with
  `org_budget_exceeded`, and a workflow step, evaluation or job fails with
  that code. Local models are never stopped. Unset means no org cap. The global
  `globalMonthlyBudgetUsd` stays an install-wide ceiling: it totals every
  org's spend, so one tenant can still exhaust it for everyone unless each
  org has a cap below it. See
  [Costs → Per-org monthly budget cap](../admin/orchestration-costs.md#per-org-monthly-budget-cap).
- **Each org can have its own API request cap** (§110 t-789). Set
  `settings.quotas.requestsPerMinute` the same way, with the same
  install-org-only rule. It limits all of the org's callers together, on top
  of each caller's own limit, so one org can no longer use as much shared
  capacity as every one of its users and keys combined. The org is the one
  the guard will enter (your tenant resolver's, else the session's) or the
  key row's, never `x-sunrise-org`, and a user is counted only against an org
  they are an active member of. Embed-widget traffic, the platform admin
  surface, listing orgs and switching between them are not counted. Unset means no org
  cap, and at `single` nothing is counted. Another instance can enforce an old cap for up
  to 30 seconds, and with several instances each counts separately. See
  [Rate limiting → Per-org request cap](../security/rate-limiting.md#per-org-request-cap).
- **Each org's monthly AI usage is visible to the install org** (§110 t-790).
  `GET /api/v1/admin/orchestration/costs/orgs?period=YYYY-MM` returns every
  org's spend, calls and tokens for a UTC calendar month against its budget
  cap, plus erased orgs' detached spend. The costs page shows it as a per-org
  table and each org's page shows its month to date. Only the install org may
  read it. Plans, pricing and invoices built on it are yours. See
  [Costs → Per-org usage](../admin/orchestration-costs.md#per-org-usage).
- **The data subject is per org.** `eraseUser` / `exportUserData` act inside
  the org the request entered: a person with memberships in several orgs is
  erased from, and exported from, the org that asked — the tenant is the
  controller of its members' data (project decision, 2026-09-21). A
  platform-wide export for one person across every org is a future
  platform-admin provision, not a gap.

What does **not** yet work at `multi`, honestly, because the features that
own it have not shipped (the Multi-tenancy phase on the Hub; the design
record's [target architecture](./multi-tenancy-design.md#target-architecture)
says which piece each feature lands):

- **The Learn page is the install org's alone.** The Pattern Advisor, the
  Quiz Master and their patterns knowledge help the install's app admins
  build their app, so they exist only in the install org. It is a platform
  page, so an org admin is not shown it and is refused it (§111). A platform
  admin switched into a customer org still finds it empty there.
- **Some process-global state is shared across orgs on purpose.** RLS cannot
  see a Node heap, so every module-level holder in `lib/` is declared in
  [`lib/tenancy/process-state.ts`](../../lib/tenancy/process-state.ts) with
  the posture it carries (§108 t-712). What that leaves shared is the
  deliberate part: an LLM provider's client, circuit breaker and in-flight
  counter are keyed by (provider slug, credential identity) (§120 t-744), so
  orgs on the install's shared credential share them — a breaker one of them
  opens pauses all of them — while a per-org credential from the
  `lib/app/provider-credentials.ts` seam gets its own; the
  outbound host limiter is per third-party host; the rate-limit counters are
  keyed by the caller. The admin log buffer is the one holder scoped at the
  QUERY rather than partitioned: one process-wide ring, each entry stamped
  with the org that produced it, and `getLogEntries` filtering to the reader's
  (§108 t-714). The MCP session map was the second (t-716) and is no longer in
  the manifest at all: the stateful MCP transport was removed in §39 t-718, so
  there is no session map to scope. No row in the manifest is a declared
  defect.
- **One admin console.** The authorization policy already distinguishes a
  platform admin from an org OWNER/ADMIN, but the console is not split; the
  [control-plane map](#the-control-plane-which-admin-surfaces-are-whose)
  below is what §111 splits along.
- **Storage and quotas** — §109 / §110. Provider policy is enforced at call
  time (above); offering only approved providers when an agent is configured
  is §120 t-743.

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

It also turns on the per-org provider policy: every org except the install
org may now call only the providers granted to it, and every org starts with
none. An install that already has customer orgs when it flips must grant each
one its providers (on `/admin/orgs/[id]`, or `PUT /api/v1/admin/orgs/[id]/providers`), or their calls
are refused with `provider_not_permitted`. The install org is unaffected.

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

| Change in a release                                                  | Caught by                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new model nobody classified                                        | `model-classification.test.ts`                                                                                                                                                                                        |
| A tenant-owned table without a policy; `migrate dev` dropping one    | `policy-coverage.test.ts`; the T-series in `db:drift-check`                                                                                                                                                           |
| A new raw-SQL site                                                   | `db-raw-sql-allowlist.test.ts` (it must be admitted; whether it stamps or scopes correctly is the reviewer's)                                                                                                         |
| A global slug on a tenant-owned model                                | `org-scoped-slugs.test.ts`                                                                                                                                                                                            |
| A model missing from the org export                                  | `org-sources.test.ts`                                                                                                                                                                                                 |
| A create shape the injection misses; a transaction the setter misses | `tests/unit/lib/db/tenancy-extension.test.ts` (real client, recording driver)                                                                                                                                         |
| A platform job with no declared tenant scope                         | the type-check (`PlatformJob.scope` is required) and `platform-jobs.test.ts`, which pins every task's scope                                                                                                           |
| A per-org job that would have run inside the caller's org            | `run-tick.test.ts` / `platform-jobs.test.ts` — the tick started inside a foreign org sweeps every org                                                                                                                 |
| A job's writes landing with no org                                   | `smoke-multi` scenario [10] — a per-org job through the registry; every row it creates carries its org                                                                                                                |
| A new process-global cache nobody gave a tenancy posture             | `process-state.test.ts` — it scans `lib/**` and names the undeclared holder, and names a declared row whose holder has gone. Blind to a holder built by a factory it does not know by name; see the review step below |
| Anything the above miss that a real policy would refuse              | `smoke-multi` on every upstream PR — the harness as the restricted role                                                                                                                                               |

**Neither of the greps this section used to carry survives.** The jobs one is
fully retired: a job cannot be added to the platform table without a `scope`,
and a fork's `registerAppJob` defaults to `per-org` (§108 t-711). The
process-global-state one is retired because it never worked — it looked for
`new Map(`, and every cache in this tree is written `new Map<string, X>()`,
so it matched none of them and reported clean at every sync.

What replaces it, and exactly how far it goes:
[`lib/tenancy/process-state.ts`](../../lib/tenancy/process-state.ts) declares
every module-level holder in `lib/` with its posture, and
`tests/unit/lib/tenancy/process-state.test.ts` fails on an undeclared holder
**and** on a row whose holder is gone.

**That is a build failure for the shapes the scanner can see, and a review
step for the rest** — which is why this is one line of reading rather than
nothing. A holder built by a factory the scanner does not know by name is
invisible to it; three review rounds on the PR that introduced the manifest
each turned up more of them, and the last one found four still missing. So
when a release touches `lib/`, the question to carry is not "did a grep
fire" but:

> **Did anything new start holding state between requests — a cache, a
> registry, a counter, a limiter — and if two orgs used this install, could
> one org's entry be served to the other?**

The answer goes in the manifest as a row. `.context/tenancy/context.md`
[has the five answers it maps to](../tenancy/context.md#adding-process-global-state-the-one-review-step-the-context-cannot-cover).
A fork's own state under `lib/app/**` or `lib/framework/**` is not scanned —
it is yours — but the question is identical, and a manifest of your own is
the cheap way to answer it.

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
  read, logged at `debug`, and `runAsCrossOrgCount` the same for a read-only
  global-config usage count, also at `debug` and confined to one module
  (§107 t-752). Nothing else should run inside any of them.
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
- **Flip `TENANCY_MODE=multi` only after the policies are enabled — the order
  matters more since §108.** Confining a per-org job is RLS's doing, not the
  job's: the tick now runs each sweep once per org, so at `multi` with the
  policies still dormant every sweep sees every org's rows and does the same
  unscoped work N times. `backfillMissingEmbeddings` would spend N× the
  embedding calls, and the retention sweep would report the same deletions N
  times. (Before §108 those jobs threw once and did nothing — loud, and
  free.) Nothing asserts the pairing at runtime; `TENANCY_MODE=multi npm run
db:drift-check` is what tells you, and the order in
  [enabling it end to end](#enabling-it-end-to-end) is enable, then flip.
- **Neon's deploy role bypasses RLS.** `neondb_owner` inherits `BYPASSRLS`
  from `neon_superuser`; it is the owner DSN, never the app's. Neon also
  refuses `DROP OWNED BY`, which is why `--drop` revokes grants first.
- **A registered app job runs per org unless it says otherwise.** `scope`
  defaults to `'per-org'`: the job runs once per **active** org, inside that
  org's context — a suspended org is skipped (nothing should act for an org
  that has been switched off), the orgs run **sequentially**, one scope at a
  time (per-org caps are meaningless if every org runs at once), and at
  `multi` its summary entry is the fold across orgs. Declare
  `{ system: 'why' }` only for a table with **no** `orgId`: under that scope
  nothing is stamped, so a tenant-owned create lands with no org and outside
  every policy. `runAsSystem` is never the path of least resistance for a
  job that "needs to see everything" — that job is per-org, and the policies
  do the seeing ([scheduling.md → App jobs](../orchestration/scheduling.md#app-jobs--the-fork-seam-on-the-tick)).
- **A per-tenant request cap is built in; don't register an `'org'` key for
  it.** Set the org's `quotas.requestsPerMinute` (see the request-cap bullet
  above). A custom key resolver in `lib/app/rate-limit.ts` is still how to
  bucket by something else derivable from the request, a workspace or a
  device. Derive it from an authenticated principal, never from a value the
  caller controls ([rate limiting → custom keys](../security/rate-limiting.md)).
  A fork that registered `'org'` from the earlier version of this advice still
  boots, because the built-in counter does not claim that key name.

## The control plane: which admin surfaces are whose

Everything above is the **data** plane — which rows exist for whom. This
section is the **control** plane: which _admin surfaces_ a customer runs and
which stay the vendor's. It stays on this page because its reader is the
same fork that enables the capability and then has to decide what a customer
sees. §111 splits the console along it: a surface is admitted to an org
admin by declaring itself org-tier, and the declarations are one roster
([admin tiers](../auth/authorization.md#admin-tiers)). This map is the
reasoning; the roster is what runs.

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

| Surface                                                      | Backing models                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `orchestration/providers`, `orchestration/provider-models`   | `AiProviderConfig`, `AiProviderModel`                                                            |
| `orchestration/capabilities`                                 | `AiCapability`                                                                                   |
| `orchestration/agent-profiles`                               | `AiAgentProfile`                                                                                 |
| `features` (feature flags)                                   | `FeatureFlag`                                                                                    |
| `orchestration/knowledge/tags`                               | `KnowledgeTag`                                                                                   |
| `orchestration/settings`, `orchestration/mcp/settings`       | The two singletons                                                                               |
| `orchestration/mcp/tools`, `mcp/resources`                   | `McpExposedTool`, `McpExposedResource`                                                           |
| `users`, `users/[id]`, `users/invite`                        | `User` — tenancy arrives via the `Org` join, not an `orgId` column                               |
| `orgs`, `orgs/[id]` (providers only; the rest API-only)      | `Org` — the vendor's acts: create, suspend, export, delete, and which providers each org may use |
| `logs`, `orchestration/audit-log`, `orchestration/mcp/audit` | Audit models — the actor is retained deliberately                                                |
| `orchestration/learn`                                        | Static content, no data                                                                          |

Credentials are the hard stop, not a preference: `AiProviderConfig` keys its
credential off `apiKeyEnvVar` — the _name_ of a process environment variable
— which has no per-tenant form. Design decision Q3 keeps every model in this
group global in v1, with one consequence worth restating: **one embedding
model per install**, because vector dimension is a schema property.

### The customer's

These are open to the org's OWNER/ADMIN (§111 t-811). **The source of truth
for what is open is the roster, not this table:** `ORG_TIER_ADMIN_PAGES` and
`ORG_TIER_ADMIN_ROUTES` in [`lib/auth/admin-tier.ts`](../../lib/auth/admin-tier.ts),
pinned by `tests/unit/scripts/ci/admin-tier-roster.test.ts`. The roster also
lists the shared-config reads these pages need (capabilities, agent profiles,
providers and models, tags), whose writes stay the install org's. To open a
fork's own surface, declare it the same way.

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
| `members` (§111 t-813, shown at `multi` only)       | `OrgMembership` of the entered org, and invitations   |
| `support-access` (§121 t-823, `multi` only)         | `OrgSupportGrant` of the entered org                  |

### Mixed — split per viewer, not assigned

This is the "almost" in "almost 1:1", and skipping it is how a fork ships a
customer console that leaks an aggregate. §111 t-812 splits each of these
**by query, not by page**: the page is on the roster, asks who is viewing
(`adminPageViewerTier()` in `lib/auth/admin-page-viewer.ts`), and renders its
platform-ops half for a platform viewer only. The routes behind the org's
half are org-tier and read in the entered org; the routes behind the
platform-ops half are undeclared, so an org admin who calls one directly is
refused. The roster pins both.

| Page                          | The org admin's half                                                                                                       | The platform's half (absent for them)                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `orchestration` (dashboard)   | Agent count, spend, budget alerts, dashboard stats, activity: all tenant rows in their org                                 | The setup wizard and banner (providers, global settings) and capability quarantines (`AiCapability`, global)                |
| `orchestration/costs`         | Summary, alerts, trend, per-agent and per-model spend (`AiCostLog` in their org), pricing (the model catalogue, read-open) | Each org's usage (`costs/orgs`), the link to the global budget settings, and the global cap's amount and spend              |
| `orchestration/analytics`     | All of it: every figure is derived from `AiConversation` in their org, quoted text from threads they may open (§115)       | None on the page. The vendor's cross-org view of the same figures is a different query, not built                           |
| `orchestration/executions`    | The executions table (their org's, as the list route scopes it)                                                            | The live-engine cards (process-global lease and in-flight state), the lease inspector and force-fail; `executions/live` too |
| `orchestration/mcp` (landing) | The API Keys card: their org's `McpApiKey` rows, and their nav route to `mcp/keys`                                         | The server toggle, exposed tools, resources and prompts, the audit log and the settings                                     |
| `overview`                    | None. Every figure is install-wide (`User` is a system model) or the process's own, so the page stays platform-only        | All of it. `/admin` sends an org admin to the orchestration dashboard instead                                               |

`orchestration/mcp/prompts` stays platform-ops on its own: it looks like a
customer's, and is not one. `McpExposedPrompt` is on `GLOBAL_CONFIG_MODELS`:
its `createdBy` is provenance, `prompt-registry.ts` serves every enabled row
from a process-global cache to every MCP client, `name` is unique across the
install, and the enabled cap is global. Shipping this page in a customer
console publishes one tenant's prompt to all of them. Assign it to the
customer only after scoping the model (column, `@@unique([orgId, name])`,
per-org cache key and cap). (`mcp/sessions` was listed here too until §39
t-718 deleted the page with the stateful transport.)

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
  — merging a Sunrise release generally. The tenancy-specific additions this
  checklist used to carry are tests now, so a sync runs them rather than
  remembering them.
