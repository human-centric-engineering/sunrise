# Multi-Tenancy: Research and Gap Analysis

> **Status: research, not a plan.** This document maps the full surface a
> multi-tenant Sunrise would have to cover. It is not a commitment to build any
> of it, and nothing here is implemented. Sunrise ships **single-tenant** and
> that remains the default.
>
> **Two verification baselines.** Part I and the appendices were verified at
> `b7e30f06` (main) on 2026-08-01. Part II and §14 were verified at `c6b3e441`
> on 2026-08-07, and re-checked the Part I claims they depend on. Line
> references drift; the appendices carry the raw evidence.
>
> **Decisions taken 2026-08-27.** The topology, scope, org-model and
> tenant-resolution questions this document left open are now decided — Sunrise
> ships multi-tenancy as an opt-in platform capability. The binding design is
> [`multi-tenancy-design.md`](./multi-tenancy-design.md); where it and this
> survey disagree, the design document wins.

## How to read this

| If you are…                                                                      | Start at                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deciding whether to build MT into a fork                                         | [§2 The two questions](#2-the-two-questions) → [§9 Deployment topologies](#9-deployment-topologies)                                                                                    |
| Already committed and want the work breakdown                                    | [§5 Gap register](#5-gap-register) → [§10 Sequencing](#10-sequencing-shape)                                                                                                            |
| A fork author worried about upstream merges                                      | [§7 Ownership matrix](#7-ownership-platform-tier-vs-fork-tier) → [§8 Downstream forks](#8-downstream-fork-considerations)                                                              |
| A Sunrise maintainer triaging #366 / #367                                        | [§6 The decision gate](#6-the-decision-gate) → [§7](#7-ownership-platform-tier-vs-fork-tier)                                                                                           |
| A Sunrise maintainer asking what to ship for forks without building MT           | [§8 Provisions upstream should ship](#provisions-upstream-should-ship) → [§14.5](#145-what-to-commit-to-for-forks-regardless-of-question-b)                                            |
| A fork that has already shipped MT and is merging a Sunrise release              | [§8 The standing obligation](#the-standing-obligation-after-mt-ships-in-a-fork) → the playbook's [sync checklist](./multi-tenancy.md#keeping-the-retrofit-alive-across-upstream-syncs) |
| Answering a tenant asking for their own data storage, region, or encryption keys | [§5B Data handling, residency and storage](#5b-data-handling-residency-and-storage-flexibility)                                                                                        |
| Answering a tenant asking to bring their own AI provider, models, or API keys    | [§5C Provider credentials and per-tenant AI config](#5c-provider-credentials-and-per-tenant-ai-configuration)                                                                          |
| About to start building any of it                                                | [§5A Topology and the prerequisite](#5a-topology-and-the-prerequisite-nobody-costed) — **read this first**, it decides whether the rest is the right work                              |
| Wanting the answer rather than the analysis                                      | [§14 The recommendation](#14-the-recommendation)                                                                                                                                       |

### Companion documents

- [`multi-tenancy.md`](./multi-tenancy.md) — **the playbook.** The RLS recipe,
  the model inventory, the proven policy pattern, the pooled-connection
  gotchas. It covers the _data plane_ and covers it well. This document is the
  research around it, and deliberately does not repeat it.
- Issues **#366** (org-scoped admin axis) and **#367** (intra-tenant ownership
  scope) — the two tracked control-plane seams. Both are currently `blocked`.
- [`CUSTOMIZATION.md`](../../CUSTOMIZATION.md#the-appplatform-model) — the
  app/platform ownership model that decides who may edit what.
- [`VERSIONING.md`](../../VERSIONING.md#public-surface-contract-tight-definition)
  — the public-surface contract that decides what a fork can depend on.

---

# Part I — The survey

## 1. Executive summary

Sunrise today has an inert tenancy seam, a proven RLS pattern documented but
not built, and two blocked issues covering authorization. Against the two
questions people actually ask:

| Question                                                       | Coverage today |
| -------------------------------------------------------------- | -------------- |
| "Can a fork retrofit multi-tenancy without fighting upstream?" | **~50–60%**    |
| "Is Sunrise a multi-tenant platform?"                          | **~15%**       |

The gap is not mostly in the database. The playbook solves row isolation
properly — Postgres RLS below the query API, which covers ORM and raw SQL
identically. **Row isolation is one of five isolation planes, and it is the only
one anything currently addresses.** The other four (namespace, process,
temporal, external) are untracked, and three of them are _unreachable from
Postgres_ — RLS cannot help with a unique index, a Node heap, or an S3 bucket.

On top of the five planes sit two more concerns that are orthogonal to all of
them: the **control plane** (who may do what — #366/#367) and the **commercial
plane** (metering, plans, quotas, billing — entirely absent, no code at all).

The most important structural finding for fork authors: several gaps live in
**platform-tier files a fork is told not to edit**. Patched downstream they
become a merge conflict on every upstream sync — which is precisely the trap
#366 and #367 were filed to avoid, applied to files those issues do not cover.
[§8](#8-downstream-fork-considerations) enumerates them.

**Part II** answers the two asks tenants put in writing — control over data
storage, and choice of AI providers and credentials — and finds that both turn
on a question asked before either:

- **[§5A](#5a-topology-and-the-prerequisite-nobody-costed) — topology.** There
  is **no tenant context to pass**: no `AsyncLocalStorage` exists anywhere, so
  every per-tenant resolver Part II proposes is blocked on a platform-wide
  change to how identity flows. And the topology choice is three-way, not two:
  pooled RLS, **schema-per-tenant** (which §9 dismisses in one line and which
  removes an entire isolation plane), and **cells** — under which Sunrise's
  single-tenant install is already a well-formed data-plane cell.
- **[§5B](#5b-data-handling-residency-and-storage-flexibility) — data
  handling.** Storage control is a six-rung ladder; rung 5 already ships and
  rung 6 should be declined. A large share of "we must control our own data"
  requests are really **portability** requests, which Sunrise cannot satisfy at
  all today — the exporter covers configuration only — and which are an order of
  magnitude cheaper than residency. Residency also covers **processing**, not
  just storage, and nothing in the codebase models where inference happens.
- **[§5C](#5c-provider-credentials-and-per-tenant-ai-configuration) —
  providers.** Per-tenant _selection_ is largely already built. Per-tenant
  _credentials_ are blocked by the deliberate env-var-only key model and the
  total absence of reversible-secret storage. Per-tenant _defaults and budgets_
  are blocked by the two singletons. And there is a **live defect**: the
  resolver auto-attaches other providers as fallbacks, so a tenant's prompts can
  reach a provider they never authorised.

**[§14](#14-the-recommendation) states a position** rather than leaving the
trade-offs balanced. In short: answer enterprise data-control demands with a
dedicated instance, not with a pooled retrofit; evaluate schema-per-tenant
before RLS if pooling is chosen; build the five cheap compliance items now
regardless; and decline credential custody as a matter of policy.

---

## 2. The two questions

These get conflated constantly and they have different answers.

**Question A — fork enablement.** _Can a downstream fork build multi-tenancy on
Sunrise without permanently forking platform files?_ This is the question
Sunrise-as-a-template exists to answer. It is mostly about seam placement, and
it is cheap: seams cost single-tenant installs nothing.

**Question B — product.** _Should Sunrise itself ship multi-tenancy?_ This is a
product and commercial decision with a large maintenance tail: every future
feature acquires a tenancy dimension, every cache acquires a key, every
background job acquires a fairness policy, and the test matrix doubles.

The current position — recorded in
[`commercial-proposition.md`](../orchestration/meta/commercial-proposition.md)
— is "single-tenant per deployment; multi-tenancy by running separate
instances, with a documented retrofit path." **That position is defensible and
this document does not argue against it.** But it only holds if Question A is
answered well, because the retrofit path is the whole product promise for forks
that need MT.

Answering A well does _not_ require answering B yes. Most of §5 is A-work.

---

## 3. The five isolation planes

The organising idea of this document. A tenant boundary is not one thing; it is
five, and they fail independently.

| #   | Plane         | What must not cross tenants                                                        | Enforced by                     | Covered today |
| --- | ------------- | ---------------------------------------------------------------------------------- | ------------------------------- | ------------- |
| 1   | **Row**       | Table rows                                                                         | Postgres RLS + `orgId`          | Documented ✅ |
| 2   | **Namespace** | Identifiers, slugs, public URLs, dedup keys                                        | Unique indexes, route resolvers | ❌            |
| 3   | **Process**   | In-memory caches, breakers, counters, registries                                   | Application cache keys          | ❌            |
| 4   | **Temporal**  | Work running outside a request (cron, reapers, retention, workers)                 | Job scheduling + fairness       | ❌            |
| 5   | **External**  | Object storage, provider credentials/quota, outbound email/webhooks, logs, backups | Per-system scoping              | ❌            |

Two cross-cutting concerns sit above the planes:

- **Control plane** — authorization: which principal may act on which resource.
  Tracked in #366 (operator tier) and #367 (ownership scope). Blocked.
- **Commercial plane** — plans, quotas, metering, invoicing. No code exists.

### Why the plane framing matters

The playbook's central argument is correct and worth restating: app-layer
`where: { orgId }` cannot reach raw SQL, so isolation belongs in the database.
But that argument establishes RLS as the right tool **for plane 1 only**, and
it is easy to read the playbook as implying the problem is then solved.

Planes 2, 3 and 5 are structurally out of Postgres's reach:

- A **unique index is evaluated above RLS.** `INSERT` into a table with
  `slug @unique` fails on a collision with a row the caller cannot see. Tenant B
  gets `Unique constraint failed` for a slug tenant A took — a correctness bug
  _and_ a cross-tenant existence oracle.
- A **module-scoped `Map` in the Node heap** is invisible to the database. RLS
  governs what a query returns; it says nothing about what a process cached from
  a previous query.
- **S3, provider APIs, SMTP and log sinks** are not Postgres at all.

Plane 4 is subtler: RLS depends on a per-transaction `SET LOCAL app.current_org`,
and background work has no request, no session, and therefore no org to set. The
playbook's `withOrg()` wrapper has no answer for a cron tick that must
legitimately span tenants.

---

## 4. Verified current state

### What exists

| Asset                    | Location                                           | Notes                                                                 |
| ------------------------ | -------------------------------------------------- | --------------------------------------------------------------------- |
| `TENANCY_MODE` env       | `lib/env.ts`, default `single`                     | Enum seam, inert                                                      |
| Client chokepoint        | `lib/db/client.ts:35-42`                           | Throws on `multi`; ~575 importers inherit it                          |
| RLS playbook             | `.context/architecture/multi-tenancy.md`           | Recipe, inventory, gotchas                                            |
| RLS proof                | `scripts/spikes/rls-isolation-spike.mjs`           | Throwaway script, not wired into CI                                   |
| Fork seam convention     | `lib/app/*` (22 files)                             | Established pattern with a home for new seams                         |
| Second-axis precedent    | `AccountType` enum, `prisma/schema/auth.prisma:83` | Proof that an orthogonal axis can be added without overloading `role` |
| Erasure dependency graph | `.context/privacy/data-erasure.md`                 | Reusable as the org-teardown graph                                    |

### What does not exist

Verified by search at `b7e30f06`:

- **No `orgId` or `tenantId` on any of the 61 Prisma models.** Zero occurrences
  across `prisma/schema/*.prisma`.
- **No `Org`, `OrgMembership`, `Team`, or `Workspace` model.**
- **No `lib/tenancy/` directory** (`VERSIONING.md` named `lib/tenancy/client.ts`
  as the covered seam until the 2026-09-01 fix — see [§12](#12-documentation-drift)).
- **No billing, plan, subscription or metering code.** No payment provider
  integration of any kind.
- **No better-auth plugins.** `lib/auth/config.ts` registers none; `role` is the
  single `additionalField` (`config.ts:775-782`); the session carries no org.
- **No org dimension in the rate-limit key space.** `RateLimitKey` is a closed
  union of `'ip' | 'session-user' | 'api-key' | 'embed-token'`
  (`lib/security/rate-limit-policy.ts:44`).
- **No cross-tenant leakage test.** 1,030 test files, none tenancy-aware.

---

## 5. Gap register

Each entry: what is there today (with evidence), why multi-tenancy breaks it,
what would be required, and who should own the fix.

### Plane 1 — Row isolation

**Today.** Fully documented in the playbook, not built. The model inventory
classifies owners, admin-authored global config, and system/cross-tenant models.
The RLS policy pattern is proven against real Postgres including the
`NULLIF`/empty-string footgun and the per-transaction requirement.

**What's still required beyond the playbook.**

1. **Child-row policy decision at scale.** The playbook offers denormalised
   `orgId` vs join-based policy per child table and recommends denormalising hot
   paths. That decision has to be made ~30 times, and denormalisation creates a
   write-consistency obligation on every insert path — including the raw-SQL
   inserts in `message-embedder.ts` and `document-manager.ts`.
2. **Raw-SQL inventory maintenance.** The playbook's table lists six files.
   There are now **three additional app-layer raw-SQL sites** it does not
   mention (Appendix A). A prose table of raw-SQL sites will drift; this should
   be test-enforced (see [§12](#12-documentation-drift)).
3. **`FORCE ROW LEVEL SECURITY`.** The playbook mentions table owners bypass
   their own policies. Getting the role split wrong is silent — it fails open.
4. **Migration ordering.** `orgId NOT NULL` requires a backfill against live
   data; the playbook says "backfill to a default org" but a real install has
   conversations, executions and cost logs with no natural org.

**Owner.** Playbook (docs) is platform. `Org` model, migration and backfill are
fork-owned, correctly.

**Risk if skipped.** Total — this is the isolation boundary itself.

---

### Plane 2 — Namespace isolation

**Today.** 41 unique constraints, of which a large set are **globally unique
human-meaningful identifiers** (full list in Appendix B):

| Constraint                                                              | Consequence under MT                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `AiAgent.slug @unique` (`agents:9`)                                     | Tenant B cannot name an agent `support` if tenant A did           |
| `AiWorkflow.slug @unique` (`workflows:10`)                              | Same, for workflows                                               |
| `AiKnowledgeBase.slug`, `AiKnowledgeDocument.slug`, `KnowledgeTag.slug` | Same, across the knowledge layer                                  |
| `AiCapability.slug`, `AiAgentProfile.slug`                              | Shared-config models — arguably correct to stay global            |
| `AiProviderConfig.name` **and** `.slug`                                 | Blocks per-tenant provider configs outright                       |
| `FeatureFlag.name @unique` (`platform:20`)                              | No per-tenant flag values                                         |
| `McpExposedPrompt.name`, `McpExposedResource.uri`                       | Global MCP namespace                                              |
| `@@unique([channel, workflowId])` (`workflows:133`)                     | One trigger per channel per workflow, cross-tenant                |
| `@@unique([agentId, channel, fromAddress])` (`conversations:45`)        | Inbound conversation key; agentId scopes it, so this one survives |

**Why MT breaks it.** Two distinct failures:

- **Collision.** A unique index is checked above the RLS policy. Tenant B's
  `INSERT` fails against a row tenant B cannot read. The error message is a
  cross-tenant existence oracle, and the failure is unfixable by the tenant.
- **Addressability.** Slugs are _routing keys_, not just labels. Three public
  route families resolve by slug with no tenant in the path:
  - `app/api/v1/chat/agents/[slug]/validate-token/route.ts`
  - `app/api/v1/inbound/[channel]/[slug]/route.ts` — inbound Slack/Postmark/HMAC
  - `app/api/v1/webhooks/trigger/[slug]/route.ts`

  Under MT these must resolve _within_ a tenant, which means the tenant has to
  arrive some other way (subdomain, path prefix, token binding). RLS will
  correctly return zero rows for a cross-tenant slug — so the failure mode is a
  confusing 404 rather than a leak — but only if the tenant context was
  established before the query, which for an unauthenticated inbound webhook it
  is not.

**What's required.** Convert ~15 constraints to `@@unique([orgId, slug])`;
re-plan every slug-resolving route for tenant arrival; decide per-model whether
the namespace is per-tenant or genuinely global (`AiCapability` and
`AiProviderModel` are plausibly global; `AiAgent` and `AiWorkflow` are not).

**Owner.** The constraint change is fork-owned (it rides the `orgId` migration).
**The route-resolution redesign is platform-tier** — those routes are Sunrise
code and a fork cannot change how they resolve without forking them.

**Risk if skipped.** High and _silent in development_: a single-tenant test
suite and a two-tenant staging environment with distinct slugs both pass. It
surfaces when the second customer picks an obvious name.

---

### Plane 3 — Process isolation

**Today.** Process-global, module-scoped mutable state across at least 20
modules (Appendix C). The load-bearing examples:

| State                                                      | Keyed by            | Cross-tenant consequence                                        |
| ---------------------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| `settingsCache` (`lib/orchestration/settings.ts:294`)      | nothing — singleton | Tenant A's settings served to tenant B for up to 30s            |
| default-models cache (`llm/settings-resolver.ts:55`)       | nothing             | Same, for model routing                                         |
| `breakers` Map (`llm/circuit-breaker.ts:180`)              | provider slug       | Tenant A's failure storm opens the breaker for **every** tenant |
| `counts` Map (`llm/in-flight-counter.ts:24`)               | provider slug       | Tenant A's concurrency counted against tenant B's headroom      |
| model-registry hydrate cache                               | nothing             | Global model table assumed                                      |
| provider-manager, provider-test-cache                      | provider slug       | Shared credential state                                         |
| MCP session/tool/prompt/resource registries                | server-global       | One MCP namespace                                               |
| capability dispatcher, knowledge-access resolver           | varies              | Needs audit                                                     |
| in-memory rate-limit store (`rate-limit-stores/memory.ts`) | token               | Token has no org dimension                                      |

**Why MT breaks it.** RLS is irrelevant here — this state lives in the Node
heap, populated from queries that already passed policy. Two failure classes:

- **Correctness leak** (settings, registries): tenant B reads tenant A's cached
  configuration. This is a real data leak that no database control can catch.
- **Blast radius** (breakers, counters): not a leak, but a shared-fate coupling
  where one tenant's behaviour degrades every other tenant's service. In a
  commercial MT platform this is an SLA breach, not a bug.

**What's required.** Audit every module-scoped cache and either (a) key it by
org, (b) demote it to request scope, or (c) document it as deliberately global.
Then a lint rule or review checklist so new caches declare their tenancy
posture. Breakers and counters additionally need a _policy_ decision: per-tenant
breakers protect neighbours but lose the shared-signal benefit of a global one.

**Owner.** **Platform-tier, entirely.** Every file listed is Sunrise code. A
fork cannot key these without editing them.

**Risk if skipped.** High, and the settings-cache case is a genuine data leak
with no database-side detection.

---

### Plane 4 — Temporal isolation

**Today.** Background work runs on a maintenance tick with eight registered
platform jobs (`lib/orchestration/maintenance/platform-jobs.ts:103-162`) plus a
fork-owned app-job registry (`lib/app/jobs.ts`). Every one issues **global,
unscoped queries**:

| Job                                               | Query shape                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `processDueSchedules()`                           | `aiWorkflowSchedule.findMany({ where: { isEnabled, nextRunAt lte } , take: 50 })`                                                    |
| `retention`                                       | `deleteMany` across conversations, webhook deliveries, hook deliveries, cost logs, admin audit, executions, evaluation sessions/runs |
| `pendingExecutionRecovery`                        | Global scan of pending executions                                                                                                    |
| `orphanSweep`, `zombieReaper`                     | Global lease reclamation                                                                                                             |
| `embeddingBackfill`                               | Global, batch-capped at 25                                                                                                           |
| `webhookRetries`, `hookRetries`, `evaluationRuns` | Global queues                                                                                                                        |

**Why MT breaks it.** Three separate problems:

1. **No tenant context to set.** These run outside any request. `withOrg()`
   requires an org id that does not exist here. The options are (a) run the tick
   on a `BYPASSRLS` role — which re-opens the hole the whole RLS design closed,
   and means a bug in the ticker is a cross-tenant bug; (b) loop tenants and open
   one `withOrg` transaction per tenant per job — correct but O(tenants × jobs)
   transactions per tick; (c) split jobs into genuinely global (lease
   reclamation) and per-tenant (retention, schedules) and apply (a) only to the
   former under audit.
2. **Fairness.** `take: 50` on due schedules and batch caps elsewhere are
   first-come-first-served across all tenants. One tenant with 50 due schedules
   starves every other tenant for that tick. Multi-tenant schedulers need
   per-tenant quotas or round-robin, which is a real algorithm change, not a
   parameter.
3. **Per-tenant policy.** Retention windows are per-agent
   (`aiAgent.retentionDays`) and per-data-class globals. Tenants on different
   plans, in different jurisdictions, need different windows — and a
   _deleteMany_ driven by a global cutoff will over-delete for one tenant and
   under-delete for another.

**What's required.** A tenant-aware job execution model: per-tenant iteration
with fairness, an explicit and audited privileged path for genuinely global
sweeps, per-tenant retention configuration, and observability that attributes
tick work to tenants.

**Owner.** **Platform-tier.** `platform-jobs.ts`, `scheduler.ts` and
`retention.ts` are Sunrise-owned. The `lib/app/jobs.ts` seam lets a fork _add_
jobs; it does nothing to make the existing eight tenant-aware.

**Risk if skipped.** High. The bypass-role option in particular converts every
background-job bug into a potential cross-tenant incident, and it is the option
a fork under time pressure will pick because it is the only one that works
without upstream changes.

---

### Plane 5 — External isolation

**Today.**

- **Object storage** (`lib/storage/`, providers: S3, Vercel Blob, local). Keys
  are caller-supplied opaque strings (`UploadOptions.key`, `providers/types.ts:15`).
  There is no org prefix convention, no per-tenant bucket or prefix policy, and
  `lib/storage/access-tokens.ts` mints HMAC-signed access URLs that carry no org
  claim. Postgres RLS cannot reach any of this.
- **Provider credentials.** Env-var only by design (documented as a security
  property in `.context/admin/orchestration-providers.md`). One set of API keys
  for the whole install.
- **Outbound.** Webhooks (`AiWebhookSubscription`), event hooks, email, and
  channel adapters (Slack/Twilio/WhatsApp/Postmark) all resolve from global
  config.
- **Vector index.** One pgvector index over `AiKnowledgeChunk` and
  `AiMessageEmbedding` for all tenants.
- **Logging/tracing.** `getFullContext()` (`lib/logging/context.ts:174`) carries
  `requestId`, `userId`, IP, endpoint — **no org**.
- **Backup/restore.** `lib/orchestration/backup/exporter.ts` does global
  `findMany` over agents, capabilities, workflows, webhook subscriptions and
  tags — it exports the whole install.

**Why MT breaks it.** Storage is the sharpest: a signed URL is a bearer token
with no tenant claim, so key-guessing or a leaked URL crosses tenants with no
database involvement. Credentials are the most commercially significant: one
shared API key means one tenant's spend and one tenant's abuse are everyone's.
Observability without an org field makes incident response guesswork.

**What's required.** Org-prefixed storage keys plus an enforcement point (not a
convention — a convention is a plane-2-style silent failure); org claims in
storage access tokens; per-tenant provider credentials (encrypted at rest,
rotatable, attributable) _or_ hard per-tenant quotas on the shared key; org in
the log/trace context; per-tenant backup and restore; a decision on vector index
partitioning at scale.

**Owner.** **Platform-tier** for storage keys, access tokens, log context and
the exporter. Per-tenant credential storage is a shared design (schema fork-owned,
resolution platform-owned).

**Risk if skipped.** Storage: high, and undetectable from the database.
Credentials: commercial rather than security, but existential for a paid
product.

---

### Control plane — authorization

**Today.** Single global binary admin. `role` is a free-form `String` on `User`
(`auth.prisma:24`), asserted via `withAdminAuth` (`lib/auth/guards.ts:180-221`),
`hasRole`/`requireRole`, and the admin-tree gate. `withAdminAuth` takes **no
resource context**, so it cannot scope even in principle.

Also: an `admin`-scoped `AiApiKey` **bypasses the role check entirely**
(`guards.ts:193-200`) — the key's scope _is_ the capability check, no session
and no `role: 'ADMIN'` required. Under MT that is an unconditional cross-tenant
capability.

**Tracked.** #366 proposes: injectable authorization decision, an optional
resource resolver on `withAdminAuth`, centralised `role` known-values, an org
dimension (or explicit platform-only declaration) for the `admin` API-key scope,
a decision on better-auth's `organization` plugin, and a control-plane section
in the playbook. #367 proposes the ownership-scope axis reusing the same
predicate.

**What the issues get right.** The three-axis model (operator tier / ownership
scope / tenant boundary), "reuse, don't parallel", and the observation from the
Daybreak fork that the predicate needs two faces — a boolean `canRead` and a
Prisma `where`-fragment `subjectScope` — kept in lockstep by a parity test.

**What is still missing from them.**

- **Impersonation.** Mentioned only parenthetically under the better-auth
  `admin`-plugin question. Vendor support staff accessing a tenant's data is a
  hard requirement of MT SaaS and needs its own design: consent model, time
  bounds, banner, and an audit trail distinguishable from the tenant's own
  actions.
- **Admin surface split as work, not docs.** #366 item 6 asks for a
  documentation mapping of platform-ops vs tenant-admin surfaces. The actual
  work is a second console: `app/admin/*` is one tree behind one guard, and
  splitting it is navigation, layout, routing and dozens of pages.
- **Read guards.** #367 says "the read guards" resolve the predicate, but
  `withAuth` has no resource parameter either. Scoping reads is the larger half.

**Owner.** Platform-tier (as both issues correctly argue).

**Risk if skipped.** Total for the product; both issues are blocked, so nothing
downstream of them can start.

---

### Commercial plane — metering, plans, quotas, billing

**Today.** Nothing. No payment integration, no plan or subscription model, no
entitlement checks. What exists is adjacent but not the same thing:

- `AiCostLog` with per-execution USD attribution, and `checkBudget()`
  (`llm/cost-tracker.ts:427`) enforcing a per-agent cap and one **global**
  monthly cap read from the settings singleton (`globalMonthlyBudgetUsd`,
  `orchestration-providers.prisma:174`).
- Rate limiting with four key strategies, **none of them org**
  (`rate-limit-policy.ts:44`).

**Why MT breaks it.** A multi-tenant platform without per-tenant metering has no
way to price, no way to stop one tenant consuming the shared LLM budget, and no
way to answer "what did this customer cost us." `globalMonthlyBudgetUsd` under MT
means the first tenant to spend it stops the platform for everyone.

**What's required.** Plan/entitlement model; per-tenant quota enforcement in the
rate-limit key space; metering rollups from `AiCostLog` to a billing period;
invoicing and payment integration; overage and hard-stop policy; usage surfaced
to the tenant admin.

**Owner.** Plans, invoicing and payment integration are **fork-owned** — this is
product, and forks will differ. But **the org dimension in the rate-limit key
space is platform-tier and currently impossible for a fork to add** (see §8).

**Risk if skipped.** No commercial product; and operationally, an unmetered
shared LLM budget is a denial-of-wallet vector.

---

### Cross-cutting: tenant identity, lifecycle and resolution

**Today.** No `Org` model, no membership, no org in session, no tenant
resolution anywhere in `proxy.ts` (which handles request id, security headers,
rate limiting, surface classification, auth redirects and origin validation).

Bootstrap is install-scoped: the first non-service user on a fresh database is
promoted to `ADMIN`, gated on an `AuthBootstrap` singleton
(`lib/auth/config.ts:201-236`). The setup wizard is likewise install-scoped.

**What's required.**

1. `Org` + `OrgMembership` with an org-role enum; the multi-org question decides
   whether this is platform- or fork-owned ([§6](#6-the-decision-gate)).
2. **Tenant resolution strategy** — subdomain, path prefix, custom domain, or
   token binding. Each has consequences: subdomains affect cookie scope, CORS,
   CSP and certificate management; path prefixes affect every route and every
   generated link; custom domains add a provisioning and TLS story. This
   decision propagates further than any other on the list and is not mentioned
   in the playbook or either issue.
3. Active org in session (better-auth custom session fields or the
   `organization` plugin) and org switching.
4. Org lifecycle: provision → invite → suspend → delete, with delete reusing the
   erasure dependency graph.
5. Per-org bootstrap: "first user in this org becomes its admin" — a per-org
   concept the install-scoped `AuthBootstrap` singleton cannot express.

**Owner.** Split, and the split depends on §6.

---

### Cross-cutting: privacy and GDPR

**Today.** `exportUserData()` and `eraseUser()` with a 34-entry
`SUBJECT_DATA_SOURCES` manifest, test-enforced against the schema
(`tests/unit/lib/privacy/export-sources.test.ts`), plus two fork seams —
`lib/app/data-export.ts` and the erasure-hook registry
(`lib/privacy/erasure-hooks.ts`). This is the strongest-engineered part of the
codebase for this purpose.

**What MT changes.**

1. **Controller/processor flip.** Single-tenant, the operator is the data
   controller. Multi-tenant, **the tenant is the controller and the platform
   operator is a processor.** That changes who answers a subject request, what
   the DPA must say, sub-processor disclosure obligations, breach notification
   routing, and whether the operator may lawfully read tenant data at all
   (which loops back to impersonation design). This is a legal-posture change,
   not an engineering one, and it is invisible in the code.
2. **Org-level export and erasure.** Tenant offboarding needs "export everything
   for org X" and "erase org X" — different queries from the per-subject ones,
   and org deletion must not erase a user who belongs to another org.
3. **Multi-org subjects.** If a user may belong to several orgs, a subject
   request against them spans controllers. The existing manifest has no way to
   express "this row belongs to org A's controller."
4. **Per-tenant retention.** As noted in plane 4.

**Owner.** Platform-tier for the manifest's org dimension and org-level
export/erase entry points. Legal posture is the fork's (it is the one with
customers).

**Risk if skipped.** Regulatory rather than technical, and therefore easy to
defer past the point where it is expensive to fix.

---

### Cross-cutting: assurance and testing

**Today.** 1,030 test files, none tenancy-aware. The RLS proof is a standalone
throwaway script not wired into CI. There is no lint rule requiring raw SQL to
be policy-covered, and no test that runs the suite as two tenants.

**Why this matters more than usual.** Tenant isolation is a security boundary
whose failures are silent, are invisible in single-tenant development, and
compound: one missed `orgId` on one child table leaks indefinitely until a
customer notices. Every other item in this document is a one-time cost; this one
is the control that keeps them fixed.

**What's required.**

- A **two-tenant integration harness**: seed two orgs, run the API surface as
  each, assert zero cross-visibility. Should cover the raw-SQL paths explicitly.
- A **policy-coverage test** that parses the schema, lists tenant-owned tables,
  and fails if any lacks RLS enabled + a policy — the same enforcement shape as
  `export-sources.test.ts`, which is the proven pattern in this repo.
- A **raw-SQL lint** that fails on `$queryRawUnsafe`/`$executeRawUnsafe` outside
  an allowlist, so a new raw query is a conscious decision.
- **Cache-tenancy review checklist** for plane 3.

**Owner.** Platform-tier. The harness benefits every fork and cannot be written
once per fork without duplicating the schema knowledge.

---

# Part II — The tenant-facing asks

> **Verified against `c6b3e441` (main) on 2026-08-07.** Part I was verified at
> `b7e30f06` on 2026-08-01; claims carried forward from it were re-checked where
> this part depends on them.
>
> Part I surveys what multi-tenancy would break. Part II answers the two
> questions tenants actually put in writing — _can we control where and how our
> data is stored_, and _can we bring our own AI providers and credentials_ —
> and starts with the topology choice both depend on.
>
> **Read §5A first.** §5B and §5C describe what it takes to make **one pooled
> install** flexible. Whether that is the right thing to build at all is §5A's
> question, and getting it wrong wastes most of §10.

---

## 5A. Topology, and the prerequisite nobody costed

### 5A.1 The prerequisite: there is no tenant context to pass

Every seam proposed in §5B and §5C has the shape `f(config, ctx)` — a storage
resolver that takes a context, a credential resolver that takes a context, a
cache keyed on the context's org. **No such context exists, and adding one is a
platform-wide change to how identity flows.**

Verified: there is **no `AsyncLocalStorage` anywhere in the codebase.**
`lib/logging/context.ts` — the closest thing to a request context — calls Next's
`headers()` on each invocation and returns `requestId`, `userId`, IP and
endpoint. That works inside a Next request and is unavailable everywhere else.

Three distinct call-stack classes need three different answers. Treating them as
one is the mistake to avoid.

| Call stack                             | Has a session?                  | Where context must come from                                                                                                   |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **HTTP → route handler**               | Yes                             | `withAuth()` / `withAdminAuth()` (`lib/auth/guards.ts:88,167`) — they already wrap every route and already resolve the session |
| **Background jobs**                    | **No** — no request, no session | The **job record**, not ambient state. `run-tick.ts` is a single global tick guarded by a module-level `tickRunning` flag      |
| **Server components / server actions** | Yes, via `headers()`            | Same ALS store, established at the segment boundary                                                                            |

Two specifics that are easy to get wrong:

- **`proxy.ts` is the wrong place to establish it.** Next runs the proxy as a
  separate invocation from the route handler; an `AsyncLocalStorage` store
  entered there does not survive into the handler. `proxy.ts` is the right place
  to _resolve_ the tenant (from subdomain, path or token) and pass it forward as
  a header — it is the wrong place to _hold_ it.
- **`lib/auth/guards.ts` is the natural entry point**, and this is the good news.
  Every API route already goes through `withAuth`/`withAdminAuth`; they already
  do the session lookup that would produce the org. Establishing the ALS store
  there covers the entire HTTP surface with two edits — and those files are
  already platform-tier and already in scope for #366/#367.

**Background jobs get no ambient answer at all.** `run-tick.ts` runs one global
tick with a module-level overlap guard; `platform-jobs.ts` runs each task once
per interval across the whole install; the dev-mode driver is a `setInterval` in
`instrumentation.ts`. None has a tenant, and none can acquire one from context.
They need per-tenant job rows or an explicit tenant loop with the context set per
iteration — the same conclusion §5 reaches for plane 4, arrived at from the other
direction.

**The honest cost.** Ambient context is not free and its failure mode is bad:
context that is silently absent reads as "no tenant" rather than failing, which
is the class of bug RLS was chosen to prevent. Mitigate it the way the template
already mitigates the tenancy seam — **make the resolver throw when
`TENANCY_MODE=multi` and no context is set**, mirroring `lib/db/client.ts:35-42`.
Fail loud, not open.

**This prerequisite is topology-dependent.** It is unavoidable under pooled RLS,
mostly unavoidable under schema-per-tenant, and **entirely unnecessary under
cells** — which is the first hint that the topology question deserves to come
first.

### 5A.2 Schema-per-tenant: the option §9 dismisses in one line

[§9](#9-deployment-topologies) gives schema-per-tenant a single row —
"`search_path` discipline, migration fan-out, catalogue bloat" — and moves on.
That dismissal is too quick, and it is the kind of too-quick that follows from
having already written the RLS playbook.

**The mechanism is the playbook's, unchanged.** Per transaction:

```sql
-- pooled RLS (the playbook)
SELECT set_config('app.current_org', $1, true);

-- schema-per-tenant (same discipline, different payload)
SELECT set_config('search_path', format('%I, public', $1), true);
```

Same `set_config(..., true)`. Same per-transaction-never-per-session rule. Same
pooled-connection leak if you get it wrong. Same `withOrg`-shaped wrapper in
`lib/db/client.ts`. **The playbook's hardest-won lesson — and its runnable
proof — transfers wholesale.** Only the GUC changes.

**What it gives you that RLS does not:**

| Gain                            | Why                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plane 2, entirely free**      | Each schema has its own unique indexes. The ~20 constraints in Appendix B need **no** `orgId` composite; two tenants can both have an agent called `support`. The slug-collision existence oracle cannot occur                     |
| **No `orgId` columns**          | No migration across ~30 tenant-owned models, no backfill, no denormalise-vs-join decision per child table, no `NOT NULL` cutover on live data                                                                                      |
| **No policies to keep covered** | The raw-SQL inventory (Appendix A) stops being security-critical. Risk #4 — new raw SQL without policy coverage — disappears, because scoping is the connection's, not the query's                                                 |
| **Per-tenant vector index**     | Kills the blocker in [§5C](#5c-provider-credentials-and-per-tenant-ai-configuration): two tenants **can** use different embedding models, because the vector columns are per-schema                                                |
| **Backup and exit for free**    | `pg_dump --schema=tenant_x` is a per-tenant backup, a per-tenant restore, and a per-tenant export. This is [§5B's portability answer](#portability-the-cheap-substitute-for-rungs-34) with no code                                 |
| **Tenant deletion is one DDL**  | `DROP SCHEMA tenant_x CASCADE` replaces walking the erasure dependency graph for org teardown                                                                                                                                      |
| **Global config still shared**  | Reference data (`AiCapability`, `AiProviderModel`, `FeatureFlag`) stays in `public` and resolves via the `search_path` fallback — which maps **exactly** onto the playbook's "admin-authored global config" category, at zero cost |

That list covers plane 1, plane 2, most of plane 5's backup problem, and the one
item §5C calls structurally hard. It is not a small list.

**What it costs, honestly:**

- **Migration fan-out.** `prisma migrate deploy` runs once per schema. This is
  the real operational cost and it is not trivial: N schemas means N chances for
  a partial failure, and a half-migrated estate is a genuinely bad state. It
  needs a migration runner with per-tenant status tracking, which does not exist.
- **Prisma's assumption.** Prisma's `multiSchema` preview feature is for
  _statically named_ schemas; dynamic per-tenant routing is done through
  `search_path`, which works because Prisma emits **unqualified** table names
  when `multiSchema` is off. That is the standard trick and it is load-bearing —
  **verify it against Prisma 7 with a spike before committing**, exactly as the
  RLS pattern was verified.
- **Catalogue bloat.** 61 models × N schemas. At 100 tenants that is ~6,100
  tables plus indexes. Postgres copes, but `pg_dump` of the whole database,
  autovacuum scheduling, and per-connection catalogue cache all degrade. The
  practical ceiling is low hundreds, not thousands.
- **Provisioning.** Creating a tenant becomes a DDL operation, so signup does
  schema work. That is fine for sales-led onboarding and awkward for self-serve.
- **Cross-tenant queries get harder, not easier.** Platform-wide analytics that
  RLS makes trivial (query as a bypass role) become a fan-out or a rollup table.

**Verdict.** Schema-per-tenant is the strongest fit for **tens to low hundreds
of tenants** — which is the population most Sunrise forks will actually have. It
removes an entire isolation plane, the whole `orgId` migration, and the
policy-coverage burden, and it hands you per-tenant backup and per-tenant
embedding models as side effects. Pooled RLS is right above that ceiling, where
DDL-per-tenant and catalogue bloat stop being acceptable. **The playbook's
choice of RLS is correct for the topology the playbook assumes and was never
argued against the alternative.**

### 5A.3 Cells: Sunrise is already one

§5B frames storage flexibility as a ladder: one install, made progressively more
capable, with "own deployment" at the top as an escape hatch. **The architecture
large B2B platforms actually use for these requirements inverts that.** A thin
**control plane** (tenant registry, routing, identity, billing, provisioning)
sits in front of N independent **data-plane cells**, each a complete, ordinary
install. Tenant→cell placement is a routing decision, not an application
feature. Slack, Salesforce, Shopify (pods) and AWS itself are built this way.

The implication should be said plainly:

**Sunrise's single-tenant install is already a well-formed data-plane cell.**
One `DATABASE_URL`, one storage provider, one environment, one set of provider
keys, `TENANCY_MODE=single`, no tenancy machinery to build. What is missing is
not in Sunrise and arguably should never be in Sunrise — it is the control
plane, which is a separate service.

One qualification the enthusiasm should not skip: **the identity plane is not
already a cell.** `AuthBootstrap` is install-scoped, better-auth config is
per-install, and a user who needs access to two tenants has two accounts unless
the control plane federates identity. That is real work, and it sits in the
control plane rather than in Sunrise.

Under this framing, §5B's expensive rungs stop being application work:

| Ask                            | As an application feature (pooled)                                             | As a cell property                                  |
| ------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------- |
| Own region / bucket (rung 2)   | Per-tenant storage registry, residency on `Org`                                | The cell runs in that region                        |
| Customer-managed keys (rung 3) | Envelope encryption layer, per-tenant DEKs, rotation                           | The cell's database/bucket uses their KMS key       |
| Own database (rung 4)          | Pool registry, DSN routing, migration fan-out                                  | The cell **is** their database                      |
| Own provider keys (§5C, B2)    | Credential resolver, cache re-keying, custody risk                             | The cell's `process.env` — today's model, unchanged |
| Own defaults/budget (§5C, B3)  | De-singleton `AiOrchestrationSettings`, keyed caches, distributed invalidation | The cell's singleton **is** their singleton         |
| Processing residency           | Per-tenant provider eligibility policy, enforced at resolution                 | The cell's configured providers                     |

That table is the case for cells in one page. **Every hard item in §5B and §5C
is free in a cell and expensive when pooled** — because each is a per-install
assumption, and a cell is an install.

**What cells cost, honestly:**

- **The control plane is a whole system** — tenant registry, routing, cell
  placement, federated identity, aggregated billing, and its own security
  boundary. It does not exist and Sunrise does not contain it.
- **Fixed cost per cell.** Bad economics below a certain ARPU. A hundred
  £20/month tenants cannot each have a Postgres instance.
- **Provisioning automation is a prerequisite, not a nice-to-have.** Cells only
  work if creating one is a pipeline (IaC + migration + seed + DNS + secrets),
  not a runbook. Sunrise ships Docker deployment; it does not ship that pipeline.
- **Upgrade fan-out.** Every release deploys N times, and version skew across
  cells becomes a support dimension.
- **Cross-cell reporting** needs its own aggregation layer, since no single
  database holds it.

### 5A.4 The three-way comparison

| Dimension                       | **Pooled + RLS**                       | **Schema-per-tenant**                  | **Cells**                                   |
| ------------------------------- | -------------------------------------- | -------------------------------------- | ------------------------------------------- |
| Planes solved by the topology   | 1 only                                 | 1 **and 2**                            | 1, 2, and most of 5                         |
| Planes still to build           | 2, 3, 4, 5                             | 3, 4, 5                                | 3, 4 (per cell — trivially, they're global) |
| Tenant context primitive (5A.1) | Required                               | Required                               | **Not required**                            |
| `orgId` migration               | ~30 models + backfill                  | **None**                               | **None**                                    |
| Policy-coverage burden          | Permanent                              | **None**                               | **None**                                    |
| Per-tenant embedding model      | Blocked (shared vector columns)        | **Free**                               | **Free**                                    |
| Per-tenant provider credentials | Credential resolver + custody decision | Credential resolver + custody decision | **Free** — the cell's env                   |
| Per-tenant backup / exit        | Build it                               | **`pg_dump --schema`**                 | **Free**                                    |
| Tenant teardown                 | Erasure graph                          | `DROP SCHEMA CASCADE`                  | Destroy the cell                            |
| Practical tenant ceiling        | Thousands+                             | Low hundreds                           | Tens                                        |
| Provisioning cost per tenant    | A row                                  | DDL                                    | A deployment                                |
| Upgrade cost                    | One deploy                             | One deploy, N migrations               | N deploys                                   |
| Cross-tenant analytics          | Trivial                                | Fan-out or rollups                     | Aggregation layer                           |
| Marginal infra cost per tenant  | Near zero                              | Near zero                              | Material                                    |

**How to read it.** The three columns are ordered by tenant count, and the
work moves from build-time to run-time as you go right. Pooled RLS front-loads
engineering and amortises it; cells front-load nothing and pay per tenant
forever. Schema-per-tenant sits in the middle and is the only one that removes a
whole isolation plane without paying per-tenant infrastructure.

**The uncomfortable implication for this document.** The tenants who generate
the §5B and §5C requirements — the ones asking for their own storage, their own
keys, their own models — are precisely the tenants who are **few, large, and
high-ARPU**. That is the right-hand column. Building pooled RLS in response to
an enterprise data-residency request is answering the question with the topology
that serves that question worst.

This is **not** an argument against the playbook. Pooled RLS remains correct for
self-serve volume, and a bridge topology needs it alongside a siloed tier. It is
an argument against treating the pooled retrofit as the default response to a
requirement that arrived from an enterprise prospect. See
[§14](#14-the-recommendation) for where this lands.

---

## 5B. Data handling, residency, and storage flexibility

### The ask, split into three things that get conflated

"Tenants want control over their data" is nearly always three separate
requirements wearing one coat, and they have very different costs.

| #      | Requirement   | What it actually means                                                                               | Cost centre                |
| ------ | ------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| **A1** | **Assurance** | Answer a security questionnaire / DPA with accurate, evidenced statements about handling and storage | Documentation + telemetry  |
| **A2** | **Guarantee** | The isolation claimed in A1 is enforced by a mechanism, not by discipline                            | The five planes in §3      |
| **A3** | **Bespoke**   | This particular tenant's data physically lives somewhere they specify, under keys they hold          | Deployment topology matrix |

A1 and A2 are table stakes for any paid multi-tenant product and are largely
answered by finishing the work already in §5. **A3 is the expensive one, and it
is the one usually being asked for.**

A fourth requirement hides inside A3 and is much cheaper to satisfy —
[portability](#portability-the-cheap-substitute-for-rungs-34). Establish which
one the tenant actually wants before costing anything.

### What the code assumes today

Every one of these is a single-install assumption. None is wrong for a
single-tenant deployment; all are load-bearing if a tenant wants their own
storage arrangement.

| Assumption                               | Evidence                                                                                                                                                                                                               | Consequence for A3                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **One database, one DSN**                | `lib/db/client.ts` — one `Pool` over `env.DATABASE_URL`, memoised on `globalThis`                                                                                                                                      | A per-tenant DSN needs a **pool registry**, not a wrapped client. Different change from `withOrg` |
| **One storage provider**                 | `getStorageClient()` (`lib/storage/client.ts:41`) caches one provider chosen from `process.env` on first call                                                                                                          | Per-tenant bucket/region/backend needs the same registry treatment                                |
| **Storage keys carry no owner**          | `avatars/${userId}/avatar.jpg` (`lib/storage/upload.ts:102`); `${prefix}${randomUUID()}` (`upload-to-storage.ts:296`)                                                                                                  | No org prefix to enforce, and nothing to authorise a signed URL against                           |
| **Signed URLs carry no tenant**          | `lib/storage/access-tokens.ts` — payload is `{ key, expiresAt }`; the module comment states key-binding _is_ the whole access-control model                                                                            | A leaked or guessed URL crosses tenants with the database uninvolved                              |
| **One install-wide signing key**         | `BETTER_AUTH_SECRET` signs sessions, email-change JWTs (`lib/auth/change-email.ts:82`), storage access tokens, **and** approval tokens (`lib/orchestration/approval-tokens.ts:34`)                                     | One secret, four blast radii. No per-tenant key material exists anywhere                          |
| **No encryption-at-rest primitive**      | No `createCipheriv`/`createDecipheriv`, no KMS/Vault/Secrets-Manager client anywhere in `lib/`. The only cryptographic secret handling is **one-way** SHA-256 (`AiApiKey.keyHash`, `lib/orchestration/mcp/auth.ts:44`) | Customer-managed keys are not a config change — the envelope layer does not exist                 |
| **One vector index**                     | Single pgvector index over `AiKnowledgeChunk` / `AiMessageEmbedding`                                                                                                                                                   | Residency claims must cover embeddings, which are derived copies of the source text               |
| **Config export only**                   | `lib/orchestration/backup/exporter.ts` — unfiltered `findMany`, and its header states it **"excludes secrets, embeddings, and user-specific data"**                                                                    | There is no export of tenant _content_ at all — see portability below                             |
| **Privacy entry points are per-subject** | `eraseUser()`, `exportUserData()`, `SUBJECT_DATA_SOURCES` (`lib/privacy/export-sources.ts`)                                                                                                                            | Art. 15/17 work exists and is enforced by test — but there is no org-level erase or export        |

The last row is the strongest existing asset. The `SUBJECT_DATA_SOURCES`
manifest with its schema-parsing test is exactly the kind of
enforced-completeness mechanism the rest of this section keeps asking for. **An
org-level equivalent is a smaller job than building it from nothing** — it is
the same manifest with a second dimension.

### The flexibility ladder

Storage flexibility is not a yes/no. It is a ladder, and each rung is a distinct
product tier with a distinct cost. Naming the rungs is what stops a sales
conversation promising rung 6 and engineering budgeting for rung 1.

**The ladder assumes one pooled install made progressively more capable.** Under
[§5A.3](#5a3-cells-sunrise-is-already-one) rungs 2–4 are properties of cell
placement instead, and cost nothing to build.

| Rung  | What the tenant gets                                | What Sunrise must build                                                                                                         | Industry precedent                            | Verdict                              |
| ----- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| **0** | Shared everything, isolation by RLS                 | §5 planes 1–5                                                                                                                   | Universal for self-serve SaaS                 | The baseline                         |
| **1** | Org-prefixed keys, org claim in signed URLs         | Enforced key prefix (not a convention); `org` in the access-token payload and the read route's check                            | Universal                                     | **Do this regardless**               |
| **2** | Own bucket and/or region (storage residency)        | Per-tenant storage resolution: a registry keyed by org replacing the singleton; residency recorded on `Org`                     | Standard enterprise tier                      | **Realistic**                        |
| **3** | Customer-managed encryption key                     | **Not application encryption** — see the correction below. A managed-storage CMK plus the key-revocation runbook                | Standard at the top of the market             | **Realistic, cheaper than it looks** |
| **4** | Own database (DSN per tenant)                       | Pool registry, migration fan-out, tenant→DSN routing, N backup schedules                                                        | Common at tens-of-tenants scale               | **Realistic, operationally heavy**   |
| **5** | Own deployment                                      | Nothing — **this is what Sunrise does today**                                                                                   | Universal for regulated/high-ARPU             | **Already available**                |
| **6** | Arbitrary bespoke storage backend of their choosing | A storage abstraction general enough for any backend, plus per-backend migrations, backup, DR, retention, export, vector search | **Effectively no precedent at product scale** | **Not realistic**                    |

**Rung 3 needs a correction that changes its price.** "Customer-managed keys"
read as _application-level envelope encryption_ is close to unbuildable here:
encrypted columns cannot be indexed, matched with `LIKE`, or searched with
pgvector — which removes the knowledge base outright, since similarity search is
raw SQL over a vector index (Appendix A). What satisfies nearly every auditor is
**volume-level encryption with a customer-managed KMS key**, which RDS, Aurora
and Cloud SQL all offer natively and which requires **no application change at
all**. Reserve application-level encryption for narrow fields that are never
queried. Read rung 3 as "customer-managed key on managed storage", and it drops
from "expensive" to "a deployment option plus a documented revocation path".

### The honest answer on rung 6

**A general "bring your own storage system" promise is not a feature, it is a
product line.** The reason is not that the abstraction is hard to write — it is
that every storage topology multiplies work that is invisible at design time:

- **Migrations** fan out. Every schema change runs N times, and one tenant's
  failed migration is a support incident, not a rollback.
- **Backup and DR** fan out, and a tenant-supplied backend means their RPO/RTO
  is partly their responsibility and wholly your liability.
- **Retention and pruning** (`.context/orchestration/retention.md`) currently
  runs per data class against one database. Per-backend it becomes N jobs with
  N failure modes and no shared observability.
- **Subject access and erasure** (`SUBJECT_DATA_SOURCES`) must reach every
  backend, or your Art. 15 answer is silently short — the exact failure the
  existing manifest test was built to prevent.
- **Vector search** is the sharpest: pgvector similarity search is raw SQL
  against a Postgres index. A tenant on a non-Postgres backend does not get the
  knowledge base, or gets a second implementation of it.
- **Incident response** across heterogeneous backends is guesswork, and it is
  precisely when you least want guesswork.

The industry does not solve this by generalising the storage layer. It solves it
by **tiering the deployment topology** — pool / bridge / silo
([§9](#9-deployment-topologies)), or the three-way choice in
[§5A.4](#5a4-the-three-way-comparison). Sunrise already ships rung 5. That is a
legitimate answer to a demanding tenant, not a cop-out.

One genuine exception: **BYO bucket for the bulk data plane only** — the tenant
supplies an S3 bucket in their own cloud account, reached via a cross-account
role, and only uploaded documents and exports live there. Metadata, embeddings
and everything transactional stay put. This is a real pattern, materially
cheaper than rung 4, and it satisfies a surprising share of "we must hold our
own data" requirements because the documents are what the tenant actually cares
about. It is rung 2 with an outward-facing credential model, and it maps onto
the existing `StorageProvider` interface.

### Portability: the cheap substitute for rungs 3–4

Before costing any rung above 2, establish what the tenant is actually
protecting against. "We must control our own data" usually decomposes into one
of three fears, and only one of them needs a storage topology:

| The fear                                    | What actually answers it                                     | Cost           |
| ------------------------------------------- | ------------------------------------------------------------ | -------------- |
| "You'll leak it to another customer"        | Isolation evidence — §5's planes plus the two-tenant harness | Already scoped |
| **"We'll be locked in / you'll disappear"** | **A per-tenant export in a documented format**               | **Small**      |
| "It must not physically reside there"       | Rungs 2/4/5 — genuine residency                              | Large          |

The middle row is the one that gets mis-diagnosed as the third, and it is far
cheaper to satisfy. **Today Sunrise cannot answer it at all.**
`lib/orchestration/backup/exporter.ts` exports **configuration only** — its
header states it excludes secrets, embeddings and user-specific data — so
agents, workflows and capabilities come out, and conversations, messages,
knowledge documents and chunks do not. `exportUserData()` covers a single data
subject, not a tenant.

**What a per-tenant export needs:** the `SUBJECT_DATA_SOURCES` manifest with an
org dimension, a documented schema, and a restore path that is tested rather
than asserted. That is the same enforced-manifest mechanism the repo already
runs, extended — not a new subsystem.

Two things make this the best-value item in the section. First, it converts an
unbounded architectural demand into a bounded engineering task. Second, under
[schema-per-tenant](#5a2-schema-per-tenant-the-option-9-dismisses-in-one-line)
it is **free** — `pg_dump --schema=tenant_x` is the export, and a restore into
any Postgres is the exit story. An exit guarantee frequently closes the deal
that a residency guarantee was being demanded to close.

### Residency covers processing, not just storage

Rung 2 is about where bytes rest. Auditors and DPAs also ask where they are
**processed**, and for an AI platform that is the sharper question: an EU
tenant's prompts hitting a US inference endpoint is a transfer, whatever the
database's region.

Sunrise has no concept of it. Verified: `AiProviderConfig` carries `baseUrl` but
no region, jurisdiction, or data-handling attributes; nothing in
`lib/orchestration/llm/` references data retention or zero-retention endpoints.
The nearest existing seam is `AiProviderModel.deploymentProfiles`
(`orchestration-providers.prisma:89`) — a `String[]` whose documented vocabulary
already includes `hosted`, `sovereign`, and reserved `edge` / `air_gapped`. It
is consumed only for tier derivation in the admin matrix
(`lib/orchestration/prefetch-helpers.ts:212`); **nothing enforces it at
resolution time.** The classification vocabulary exists; the enforcement does
not.

The mechanism and the fallback defect are in
[§5C](#processing-residency-data-retention-and-the-sovereign-seam). What matters
here is that a residency claim scoped to storage alone is an incomplete answer,
and incomplete answers are what fail audits.

### The one change that keeps the ladder reachable

**`lib/storage/` already has the right shape.** `StorageProvider`
(`providers/types.ts`) is a clean interface with three implementations. The only
thing blocking per-tenant storage is that `getStorageClient()` resolves it
**once, from `process.env`, into module state**. Turning that into a resolver
that takes a context and consults a registry is small and low-risk, and costs a
single-tenant install nothing.

The database side is not as lucky. `lib/db/client.ts` exports a client instance,
not a factory, and ~575 importers depend on that shape. The `withOrg` wrapper
preserves it; a per-tenant DSN does not. **Rung 4 is a different retrofit from
the one the playbook describes**, and a fork that assumes database-per-tenant is
a lighter variant of it will be surprised.

Both resolvers take a context, and
[that context does not exist](#5a1-the-prerequisite-there-is-no-tenant-context-to-pass).

### What "answer the questions" actually requires

Requirement A1 — answering a security questionnaire honestly — is mostly
documentation, but each answer has a code dependency. This table converts a
compliance ask into a work list.

| Questionnaire item                           | Answerable today?               | Code dependency                                                                                                                                       |
| -------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encryption in transit                        | Yes                             | Deployment-level (TLS)                                                                                                                                |
| Encryption at rest                           | Yes, inherited from DB/bucket   | Nothing — but "inherited" is the honest wording, not "we encrypt"                                                                                     |
| **Customer-managed keys**                    | **Only at rung 5**              | Managed-storage CMK — a deployment option, not an application feature                                                                                 |
| **Key management / rotation**                | **Partially, and weakly**       | One `BETTER_AUTH_SECRET` across four token types; rotation invalidates all four at once                                                               |
| **Storage residency**                        | **Only at rung 5**              | Rung 2 (storage) + rung 4 (database)                                                                                                                  |
| **Processing residency (inference)**         | **No**                          | No region or jurisdiction attribute on providers; nothing enforced at resolution ([§5C](#processing-residency-data-retention-and-the-sovereign-seam)) |
| **Provider data retention / ZDR**            | **No**                          | No concept anywhere in `lib/orchestration/llm/`                                                                                                       |
| Tenant isolation mechanism                   | Documented, not built           | Planes 1–5                                                                                                                                            |
| **Deletion SLA (Art. 17)**                   | **Per user yes, per tenant no** | Org-level `eraseUser()` equivalent; the erasure graph already exists                                                                                  |
| **Subject access (Art. 15)**                 | **Per user yes, per tenant no** | Org dimension on `SUBJECT_DATA_SOURCES`                                                                                                               |
| **Tenant data export / exit**                | **No — config only**            | Per-org export ([portability](#portability-the-cheap-substitute-for-rungs-34))                                                                        |
| **Sub-processor disclosure**                 | **Install-wide only**           | Per-tenant provider routing, and the fallback defect in [§5C](#the-auto-fallback-defect)                                                              |
| **Audit evidence per tenant**                | **No**                          | Org in `getFullContext()` (`lib/logging/context.ts:174`)                                                                                              |
| **Breach scoping ("whose data was in it?")** | **No**                          | Same — without org in the log context this is reconstruction, not lookup                                                                              |
| Backup and restore per tenant                | **No**                          | Per-org exporter                                                                                                                                      |

**Five of these are individually small and collectively decisive**: org in the
log context, org-level erase/export, org-prefixed storage keys, an org claim in
access tokens, and a per-tenant export. They are worth more per unit of effort
than anything else in Part II, they are needed under **every** topology in
[§5A.4](#5a4-the-three-way-comparison), and they are all platform-tier (§7).

### Verdict on the storage requirement

- **A1 (assurance)** — realistic, and the cheapest high-value work in this
  document. Mostly the five small platform items above.
- **A2 (guarantee)** — realistic; it is §5 in full, already scoped.
- **A3 (bespoke)** — realistic **up to rung 4**, and rung 5 already ships.
  Rung 6 should be declined, and declined early. The honest position is a
  published tier ladder, not an open-ended commitment to accommodate any storage
  system a tenant names.
- **Diagnose before costing.** A large share of A3 requests are portability
  requests, and portability is an order of magnitude cheaper.
- **For a fork specifically.** Rungs 0–2 and portability are reachable inside
  fork-owned files today; the Art. 15 seam (`lib/app/data-export.ts`) is where
  your org-owned tables join the export. Rung 4 is not fork-reachable —
  `lib/db/client.ts` exports a client instance and the per-tenant DSN registry is
  platform-tier ([§7](#7-ownership-platform-tier-vs-fork-tier)). Do not sell
  rung 4 on the assumption it is a lighter variant of the playbook's retrofit;
  it is a different one.

---

## 5C. Provider credentials and per-tenant AI configuration

### Three separable asks, and only one of them is hard

| #      | Ask                                                                       | Status today                                               |
| ------ | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **B1** | Tenant chooses provider/model for specific agentic processes              | **Largely already possible** — the seam exists             |
| **B2** | Tenant supplies their own API credentials (possibly from their own vault) | **Blocked** — structurally, not incidentally               |
| **B3** | Tenant sets their own defaults, allowed models, and budget policy         | **Blocked by the two singletons** — the underestimated one |

### B1 — the good news, in detail

Sunrise already has a per-agent provider override seam and it is not vestigial:

- `AiAgent.provider`, `AiAgent.model`, `AiAgent.fallbackProviders` and
  `AiAgent.providerConfig` (`orchestration-agents.prisma:13-16`) are per-agent
  columns.
- `resolveAgentProviderAndModel()` (`lib/orchestration/llm/agent-resolver.ts`)
  implements an explicit contract: **an empty string means "inherit the system
  default"; an explicit value always wins.** Per-agent choice is the primary
  path, with inheritance as the fallback.
- `AiAgent` is already classified **tenant-owned** in the playbook's model
  inventory, so once `orgId` lands on it, per-tenant agent-level provider and
  model selection comes along **for free**.

The _selection_ half of "a tenant wants their own provider and model for certain
agentic processes" is already built. What is missing is the _credential_ half
(B2) and the _policy_ half (B3).

Two catches:

- **`AiProviderConfig.name` and `.slug` are globally `@unique`**
  (`orchestration-providers.prisma:43-44`). Per-tenant provider rows need the
  plane-2 composite (Appendix B) — or schema-per-tenant, which removes the
  problem entirely ([§5A.2](#5a2-schema-per-tenant-the-option-9-dismisses-in-one-line)).
- **Agents reference providers by slug string**, resolved globally. A per-tenant
  provider row changes what that string resolves to — a resolution change, not
  just a schema change.

### The auto-fallback defect

**This is a live defect, not a future one, and it inverts B1's guarantee.**

`agent-resolver.ts:83-93`: when an agent has **no explicit** `fallbackProviders`
list, the resolver attaches _every other reachable provider_, capped at
`SYSTEM_FALLBACK_LIMIT` (3):

```ts
const fallbacks =
  explicitFallbacks.length > 0
    ? explicitFallbacks
    : candidates
        .map((c) => c.slug)
        .filter((slug) => slug !== providerSlug)
        .slice(0, SYSTEM_FALLBACK_LIMIT);
```

Those fallbacks are consumed by the chat handler
(`streaming-handler.ts:398`). For a single-tenant install this is good
behaviour — resilience by default. **Under multi-tenancy it means a tenant's
prompts can be sent to a provider that tenant never authorised**, silently, on
any transient failure of their chosen one.

That is not merely surprising. Under GDPR Art. 28 a processor may only engage
sub-processors the controller has authorised, and the tenant is the controller
here. An unauthorised-by-default failover is a compliance defect that is
invisible in testing (it only fires on provider failure) and undetectable from
the database (`AiCostLog` records the provider used, but nobody is looking).

**What is required.** Default-deny under `TENANCY_MODE=multi`: fall back only
within a tenant-approved provider set, and if none is approved, fail the turn
rather than route elsewhere. The approved set is the same list processing
residency needs (below), so build it once.

### B2 — what breaks, with evidence

| Mechanism                        | Evidence                                                                                                                                                                                        | Why per-tenant credentials break it                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Env-var-only key model**       | `AiProviderConfig.apiKeyEnvVar` stores the _name_; value read from `process.env` at request time (`provider-manager.ts:655-660`)                                                                | The process environment is install-wide. There is no per-tenant `process.env`. This is the wall                                                                                |
| **No reversible secret storage** | No cipher or KMS client anywhere in `lib/`; `AiApiKey.keyHash` and `mcp/auth.ts:44` are **one-way** SHA-256                                                                                     | Inbound keys are verified by hash — correct. An **outbound** provider key must be _recovered_, which hashing cannot do. Nothing in the codebase can store a recoverable secret |
| **Provider instance cache**      | `instanceCache: Map<slug, {provider, cachedAt}>`, 5-min TTL (`provider-manager.ts:71`)                                                                                                          | Keyed by slug alone. With per-tenant credentials this **serves tenant A's authenticated client to tenant B** — plane 3, invisible from the database                            |
| **Circuit breaker**              | `getBreaker(slug)` — module `Map` keyed by slug (`circuit-breaker.ts:183`)                                                                                                                      | With shared keys, one tenant's abuse trips everyone's breaker. With BYO keys it is simply wrong: A's quota exhaustion opens B's breaker against a healthy key                  |
| **In-flight counter**            | `lib/orchestration/llm/in-flight-counter.ts`, same keying                                                                                                                                       | Same failure; concurrency limits become cross-tenant                                                                                                                           |
| **Cost attribution**             | `AiCostLog` has **no** `userId` or `orgId`; attribution runs through nullable `agentId`/`conversationId`/`workflowExecutionId`, all `onDelete: SetNull` (`orchestration-providers.prisma:2-27`) | Deleting an agent **orphans its cost history**. Per-tenant billing on this table needs a column, not a join                                                                    |
| **Cost reports**                 | Raw `$queryRawUnsafe` aggregation (`llm/cost-reports.ts`, Appendix A)                                                                                                                           | Covered by RLS _if_ the table carries `orgId` — which it does not today                                                                                                        |
| **Model registry hydration**     | `model-registry-db-hydrate.ts`, process-global                                                                                                                                                  | Per-tenant model catalogues need keying                                                                                                                                        |

The env-var-only design is not an oversight — it is **documented as a security
property** (`.context/admin/orchestration-providers.md:177-189`): the UI never
accepts, stores, transmits or displays a raw key; an exported provider bundle is
safe to share; a static search for key-shaped literals is a valid control.
Per-tenant credentials **give up all four**. That is the real trade, and it
should be made deliberately rather than discovered.

### The five credential models

| Model                                                  | Tenant controls                      | Sunrise must build                                                                                        | Failure modes                                                                                                                               | Right when                                                      |
| ------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **A — Shared platform keys, per-tenant quotas**        | Nothing; sees a usage limit          | Org dimension in the rate-limit key space + cost caps per org (`RateLimitKey` is a closed union — §8)     | One tenant's abuse is everyone's rate limit unless quotas are hard; margin risk is yours                                                    | Self-serve, low ARPU                                            |
| **B — Tenant keys encrypted in Sunrise's database**    | Their own vendor account and billing | Envelope encryption, key rotation, per-tenant cache keying, redaction discipline, secure recovery UX      | **You become custodian of other companies' vendor credentials.** Breach impact escalates from "our data" to "our customers' cloud accounts" | Rarely the right first choice — see below                       |
| **C — Reference into the tenant's own secret manager** | Everything; can revoke unilaterally  | A credential-resolver interface, per-tenant fetch with short TTL, failure handling when the vault is down | Runtime dependency on the tenant's infrastructure; a vault outage is an incident you are blamed for                                         | Enterprise tenants who already run Vault/KMS and asked for this |
| **D — Gateway with virtual keys** (LiteLLM, Portkey)   | Their own account behind the gateway | Point the provider `baseUrl` at the gateway; per-tenant virtual key                                       | Another hop, another sub-processor to disclose, cost figures reconciled rather than computed                                                | You want per-tenant routing quickly                             |
| **E — Workload identity federation** (Bedrock, Vertex) | Everything; **no secret exists**     | Short-lived token exchange per request; nothing stored                                                    | Only works where the provider supports it — **not** Anthropic or OpenAI direct APIs                                                         | The tenant is already on AWS or GCP                             |
| **F — The cell's own environment**                     | Everything                           | **Nothing** — today's env-var model, per install                                                          | Requires the cell topology ([§5A.3](#5a3-cells-sunrise-is-already-one))                                                                     | Few, large tenants                                              |

Six rows, because two of the credible answers are not application features at
all. **E and F are the two that store no secret**, and between them they cover
most of the enterprise cases that generate this requirement.

**Model B is the trap.** It looks like the smallest change — add an encrypted
column, done — and it carries by far the largest liability increase in this
document. Holding a tenant's Anthropic or OpenAI key means a compromise of your
database is a compromise of their vendor account, their spend, and their data at
that vendor. It puts you inside their incident response and inside their
vendor's abuse investigation. It is defensible, and plenty of products do it,
but it should be built with envelope encryption, rotation and audit **first**,
not retrofitted after the first enterprise deal.

Where the industry lands: **A for self-serve, E where the tenant is already on
AWS/GCP, D for fast enterprise routing, C for tenants who ask by name, B only
when a product has already invested in secret management.** BYO-key is common in
AI SaaS; BYO-key stored in the vendor's own database with no envelope layer is
common too, and is a recurring source of incident reports.

**The gateway (D) is an architecture, not a procurement shortcut.** The provider
instance cache, the circuit breaker, the in-flight counter and `AiCostLog`
attribution are each broken under tenancy **because Sunrise does provider
management in-process**. Extracting that into a gateway removes all four at once
instead of re-keying each, and makes the gateway the billing source of truth —
which also resolves the `SetNull` orphaning that makes `AiCostLog` unusable for
invoicing. Cost: a network hop, a component to operate, a sub-processor to
disclose.

### Processing residency, data retention, and the sovereign seam

Three questions a DPA asks that Sunrise currently cannot answer:

1. **Where is inference performed?** No region or jurisdiction attribute exists
   on `AiProviderConfig` or `AiProviderModel`. `baseUrl` implies it and nothing
   reads it that way.
2. **What does the provider retain?** No zero-data-retention concept anywhere in
   `lib/orchestration/llm/`. Several vendors offer ZDR endpoints or
   contractual terms; nothing models the distinction.
3. **Which sub-processors touch our data?** Install-wide today, and made worse
   by [the auto-fallback defect](#the-auto-fallback-defect).

**Embeddings are the easy thing to forget.** Knowledge chunks and message
embeddings are derived copies of tenant content sent to an embedding provider,
which may be a different vendor in a different jurisdiction from the chat model.
A residency answer that covers chat and not embeddings is wrong.

**There is a partial seam already.** `AiProviderModel.deploymentProfiles`
(`orchestration-providers.prisma:89`) is a `String[]` whose documented
vocabulary is `hosted` / `sovereign`, with `edge` and `air_gapped` reserved. It
is consumed only for tier derivation in the admin matrix
(`prefetch-helpers.ts:212`) — **nothing enforces it at resolution time.** The
classification vocabulary exists; the policy does not.

**What is required**, and it is one mechanism serving three needs: a per-tenant
**eligible-provider set**, enforced inside `resolveAgentProviderAndModel()`
rather than by convention, constraining the primary choice, the fallback list,
and the embedding provider alike. Sub-processor disclosure then becomes a query
rather than an assertion. Under [cells](#5a3-cells-sunrise-is-already-one) this
is the cell's provider configuration and needs no code.

### The seam that avoids choosing now

Today `provider-manager.ts` reads `process.env[config.apiKeyEnvVar]` inline.
That single call site is the entire coupling. A platform-tier
`resolveProviderCredential(config, ctx)` — defaulting to exactly today's lookup
— turns every model above into an implementation of one interface. **The `ctx`
does not exist today**
([§5A.1](#5a1-the-prerequisite-there-is-no-tenant-context-to-pass)); that, not
the resolver, is the work.

The **second** half matters as much and is easier to forget: the provider
instance cache, the circuit breaker and the in-flight counter must be keyed on
**(provider slug + credential identity)**, not slug alone. Miss it and
per-tenant credentials produce a plane-3 cross-tenant leak no database-level
test can detect — risk #3 in [§11](#11-risk-register).

### B3 — the underestimated one

Per-tenant _policy_ is harder than per-tenant _credentials_:

- `AiOrchestrationSettings` is a singleton (`slug @unique @default("global")`,
  `orchestration-providers.prisma:169-171`), holding `defaultModels`,
  `activeEmbeddingModelId` and `globalMonthlyBudgetUsd`.
- Every reader assumes exactly one row, including the TTL process caches in
  `settings-resolver.ts` and `lib/orchestration/settings.ts`.
- **Cross-instance invalidation becomes a requirement.** Today's TTL caches are
  safe because config is global and 30s of staleness is invisible; per-tenant
  config edited by per-tenant admins makes staleness visible and attributable.
  That needs Postgres `LISTEN/NOTIFY` or Redis pub/sub — new infrastructure,
  though there is precedent for adding it optionally
  (`lib/security/rate-limit-stores/redis.ts` is dynamically loaded behind
  `RATE_LIMIT_STORE=redis`, with `ioredis` kept out of `package.json`).
- `activeEmbeddingModelId` is the sharpest: it names the model whose **dimension
  the vector columns are sized for**. Two tenants on different embedding models
  need differently-shaped vectors — a schema question, not a settings question.
  **Under [schema-per-tenant](#5a2-schema-per-tenant-the-option-9-dismisses-in-one-line)
  this constraint disappears**, because the vector columns are per-schema. Under
  pooled RLS the honest options are one dimension for everyone, or an external
  vector store with per-tenant namespaces.

### Verdict on the provider requirement

- **B1 (per-agent provider/model choice)** — **realistic and mostly done**, with
  one caveat that must be fixed first: the
  [auto-fallback default](#the-auto-fallback-defect) currently routes to
  unauthorised providers, which negates the guarantee B1 appears to offer.
- **B2 (tenant credentials)** — **realistic, but it is a security-posture
  decision rather than a feature.** Models E and F store no secret and should be
  preferred; D is the fastest credible route for direct-API providers; C suits
  tenants who asked by name; B should not be the default. The
  credential-resolver seam plus cache re-keying keeps all of them open.
- **B3 (tenant defaults and budget policy)** — **realistic but larger than it
  looks**, and the one most likely to be promised casually. Budget it with the
  singleton and cache-invalidation work, not with the credential work.

- **For a fork specifically.** B1 is fork-reachable now. B2 and B3 are not:
  both depend on platform-tier seams (the credential resolver and the cache /
  breaker / counter re-keying), and doing them locally means editing five
  orchestration core files and owning that conflict on every sync. If you cannot
  wait, build the resolver in its final generic shape behind **one** call site
  ([Fork-first informs upstream](#fork-first-informs-upstream)) so the eventual
  upstream version is a delegation plus a deletion.

Both B2 and B3 feed §5B's compliance table: "which sub-processors touch our
data?" cannot be answered install-wide once tenants route to different
providers, and cannot be answered at all without org in the log and cost
records.

---

# Part III — Decisions, sequencing, and the recommendation

## 6. The decision gate

Recorded on #366 and blocking both issues:

> **Can a user belong to more than one org?**

- **Yes** → adopt better-auth's `organization` plugin. You need its membership
  table and org switching, and the cost is real: adopting its table names and
  role vocabulary, and reconciling with Sunrise's existing hand-rolled
  invitation system — a collision, not a merge. `OrgMembership` becomes
  **platform-owned**.
- **No** → hand-roll. `orgId` on tenant-owned models plus a
  `resolveAdminScope(session)` predicate. Sunrise already ships working
  invitations; the plugin would replace working code to gain nothing.
  `OrgMembership` stays **fork-owned**.

Nothing downstream can be sized until this is answered.

### Four more decisions that gate almost as much

| Decision                                                                          | Propagates to                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tenant resolution**: subdomain / path / custom domain / token binding           | Cookies, CORS, CSP, TLS, every generated URL, all slug routes                                                                                                                              |
| **Config sharing**: which of the eight admin-authored global models go per-tenant | The two singletons, seeding, backup, the admin console split ([§5C](#5c-provider-credentials-and-per-tenant-ai-configuration))                                                             |
| **Credential model**: shared provider keys with quotas vs per-tenant BYO keys     | Cost attribution, encryption at rest, breaker/counter keying — four options compared in [§5C](#5c-provider-credentials-and-per-tenant-ai-configuration)                                    |
| **Isolation topology**: pooled RLS vs schema-per-tenant vs cells                  | Whether planes 1–2 exist at all, whether a tenant-context primitive is needed, and whether §5B/§5C are application work — compared on even terms in [§5A.4](#5a4-the-three-way-comparison) |

The config-sharing decision deserves emphasis because the playbook makes it look
smaller than it is. Leaving `AiProviderConfig`, `AiCapability`, `FeatureFlag`
and friends global is the right _default_. But the two singletons —
`AiOrchestrationSettings` (`slug @default("global")`) and `McpServerConfig`
(same) — are not columns you can add an `orgId` to. Every reader is written on
"there is exactly one row," including the 30-second process cache in
`lib/orchestration/settings.ts`. Converting a singleton to a per-org row touches
every call site _and_ every cache that memoised it.

---

## 7. Ownership: platform-tier vs fork-tier

This is the matrix that decides whether the retrofit is sustainable. Anything
marked **Platform** that a fork implements locally becomes a merge conflict on
every upstream sync.

| Item                                               | Owner       | Rationale                                                                                                                         |
| -------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Org` / `OrgMembership` model                      | Depends     | Decided by §6's multi-org question                                                                                                |
| Org-role vocabulary, invitations UI, billing       | Fork        | Product-specific                                                                                                                  |
| `orgId` columns + RLS migration                    | Fork        | Rides the fork's schema                                                                                                           |
| Authorization predicate + guard signatures         | Platform    | `lib/auth/guards.ts`, `utils.ts` — #366                                                                                           |
| `role` known-values constant                       | Platform    | Same files — #366                                                                                                                 |
| Ownership-scope resolver                           | Platform    | Shared predicate — #367                                                                                                           |
| Admin API-key scope org dimension                  | Platform    | `guards.ts:193-200`                                                                                                               |
| Slug-route resolution redesign                     | Platform    | `app/api/v1/{chat,inbound,webhooks}/**`                                                                                           |
| Unique-constraint composites                       | Fork        | Rides the `orgId` migration                                                                                                       |
| Process-cache keying (plane 3)                     | Platform    | 20+ Sunrise-owned modules                                                                                                         |
| Background-job tenancy + fairness (plane 4)        | Platform    | `platform-jobs.ts`, `scheduler.ts`, `retention.ts`                                                                                |
| Rate-limit `org` key                               | Platform    | `RateLimitKey` is a closed union — see below                                                                                      |
| Storage key scoping + token org claim              | Platform    | `lib/storage/**`                                                                                                                  |
| Per-tenant provider credentials                    | Split       | Schema fork-owned; resolution platform-owned                                                                                      |
| Provider credential resolver seam                  | Platform    | `provider-manager.ts` — the `process.env` call site ([§5C](#5c-provider-credentials-and-per-tenant-ai-configuration))             |
| Provider cache / breaker / counter re-keying       | Platform    | Must key on credential identity, not slug alone                                                                                   |
| Per-tenant storage + DSN resolution registry       | Platform    | `lib/storage/client.ts`, `lib/db/client.ts` singletons ([§5B](#5b-data-handling-residency-and-storage-flexibility))               |
| Tenant-context primitive (ALS + job context)       | Platform    | `lib/auth/guards.ts`, `run-tick.ts` — blocks every seam above ([§5A.1](#5a1-the-prerequisite-there-is-no-tenant-context-to-pass)) |
| Cross-instance cache invalidation                  | Platform    | Per-tenant config makes staleness visible ([§5C](#5c-provider-credentials-and-per-tenant-ai-configuration))                       |
| Per-tenant data export (portability)               | Platform    | Extends the `SUBJECT_DATA_SOURCES` manifest ([§5B](#portability-the-cheap-substitute-for-rungs-34))                               |
| Eligible-provider policy + safe fallback           | Platform    | `agent-resolver.ts` — serves residency, sub-processor disclosure and [the fallback defect](#the-auto-fallback-defect) at once     |
| Schema-per-tenant migration runner                 | Platform    | Per-schema `migrate deploy` with status tracking, if [§5A.2](#5a2-schema-per-tenant-the-option-9-dismisses-in-one-line) is chosen |
| Control plane + cell provisioning pipeline         | **Neither** | Outside this repository entirely ([§5A.3](#5a3-cells-sunrise-is-already-one))                                                     |
| Plans, metering rollups, invoicing                 | Fork        | Product                                                                                                                           |
| Org in log/trace context                           | Platform    | `lib/logging/context.ts`                                                                                                          |
| Org-level export/erase entry points                | Platform    | `lib/privacy/**`                                                                                                                  |
| Two-tenant leakage harness + policy-coverage test  | Platform    | Benefits every fork; needs schema knowledge                                                                                       |
| Admin console split (platform-ops vs tenant-admin) | Platform    | `app/admin/**` is one tree behind one guard                                                                                       |
| Tenant resolution in `proxy.ts`                    | Platform    | Root-level request pipeline                                                                                                       |

**Twenty-two of twenty-nine rows are platform-tier.** Two of them — #366 and
#367 — are tracked. The other twenty are not. One row belongs to neither tier:
the control plane a cell architecture needs is a separate system, not a change
to this one.

Note how the count moves with the topology. Under
[cells](#5a3-cells-sunrise-is-already-one) most of these rows do not exist,
because each is a per-install assumption and a cell is an install. **The
ownership matrix is not a fixed bill of work; it is the bill for one of the
three answers in [§5A.4](#5a4-the-three-way-comparison).**

---

## 8. Downstream fork considerations

Sunrise has a three-level fork topology and two reserved namespace tiers:

```
Sunrise (platform)
  └── framework fork          e.g. Daybreak     → lib/framework/, .context/framework/, prisma/schema/framework-*.prisma, framework_ table prefix
        └── leaf fork          e.g. ConQuest     → lib/app/, .context/app/, prisma/schema/app.prisma
```

Both tiers ship **empty** upstream, which is what lets a fork's files there
merge cleanly forever. Multi-tenancy is the hardest test of that model so far,
because it is the first capability that genuinely needs to reach into platform
files.

### The merge-conflict surface, concretely

If a fork implements MT today without upstream changes, it must edit these
Sunrise-owned files. Each becomes a conflict on every sync:

| File                                             | Why the fork must edit it                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `lib/db/client.ts`                               | Replace the guard with `withOrg` — **this one is sanctioned**                                |
| `lib/auth/guards.ts`                             | Org-aware `withAdminAuth` / `withAuth` — #366/#367                                           |
| `lib/auth/utils.ts`                              | `hasRole` / `requireRole` — #366                                                             |
| `lib/auth/config.ts`                             | Org in session, per-org bootstrap                                                            |
| `lib/security/rate-limit-policy.ts`              | Add `'org'` to `RateLimitKey` — see below                                                    |
| `lib/security/rate-limit-middleware.ts`          | Resolve the new key in the `switch` at line 250                                              |
| `lib/orchestration/settings.ts`                  | De-singleton + re-key the cache                                                              |
| `lib/orchestration/llm/settings-resolver.ts`     | Same                                                                                         |
| `lib/orchestration/llm/circuit-breaker.ts`       | Key breakers by org                                                                          |
| `lib/orchestration/llm/in-flight-counter.ts`     | Key counters by org                                                                          |
| `lib/orchestration/maintenance/platform-jobs.ts` | Tenant-aware iteration                                                                       |
| `lib/orchestration/scheduling/scheduler.ts`      | Per-tenant fairness                                                                          |
| `lib/orchestration/retention.ts`                 | Per-tenant windows                                                                           |
| `lib/storage/client.ts`, `access-tokens.ts`      | Key prefixing, org claim                                                                     |
| `lib/logging/context.ts`                         | Org in context                                                                               |
| `lib/orchestration/backup/exporter.ts`           | Per-org export                                                                               |
| `app/api/v1/{chat,inbound,webhooks}/**`          | Tenant-aware slug resolution                                                                 |
| `app/admin/**`                                   | Console split                                                                                |
| `proxy.ts`                                       | Tenant resolution                                                                            |
| `prisma/schema/*.prisma`                         | `orgId` + composite uniques — **sanctioned via fork schema files** but core files change too |

Only two of these are sanctioned fork edits. The rest are the merge fight
#347/#350/#366/#367 exist to prevent.

### Seams a fork can already ride

The table above is the bad news. This is the good news, and it is usually missed
because these seams were built for other reasons. Seven `lib/app/*` registries
are **fork-owned scaffold** — Sunrise ships them empty and does not re-edit them,
so what you add merges cleanly forever. Each absorbs a piece of MT work that
would otherwise be a core edit:

| Seam                                               | MT work it absorbs                                                                | Its limit                                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `lib/app/env.ts` (`appEnvSchema`)                  | Tenancy env: privileged migration DSN, resolution mode, per-tenant storage config | None                                                                                                                                |
| `lib/app/bootstrap.ts` (`initApp`)                 | Wiring your tenant registries at boot                                             | Runs after env validation; no request context                                                                                       |
| `lib/app/jobs.ts` (`registerAppJob`)               | Tenant-aware periodic work on the existing tick                                   | The tick supplies **no** tenant context — iterate orgs yourself ([§5A.1](#5a1-the-prerequisite-there-is-no-tenant-context-to-pass)) |
| `lib/app/data-export.ts` (`collectAppSubjectData`) | Art. 15 coverage for your org-owned tables                                        | Keyed on `userId`; no org dimension ([§5B](#portability-the-cheap-substitute-for-rungs-34))                                         |
| `lib/app/db-drift.ts` (`registerAppDriftProbe`)    | CI proof that policies survived the last `migrate dev` and the last sync          | No `policyExists` / `rlsEnabled` probe factory ships — write the `pg_policies` query yourself                                       |
| `lib/app/rate-limit.ts`                            | Org-scoped rules and tiers                                                        | The **key** union is closed — see below                                                                                             |
| `lib/app/admin-nav.ts`, `protected-routes.ts`      | Tenant-admin navigation and route gating                                          | The console split itself is platform-tier                                                                                           |

Two things follow. First, **the drift-probe registry is the one nobody expects
to matter and the highest-value of the seven.** RLS policies are
Prisma-unmodelled objects in precisely the sense that registry exists for, and
`prisma migrate dev` emits `DROP` for objects it cannot represent. A fork with
policies and no probes is one routine `migrate dev` away from a green test suite
over an unprotected database — the failure mode nothing else on this page
catches. Second, **every entry in the "limit" column is a platform-tier provision
waiting to be written**; they are most of the list two subsections below.

### The `RateLimitKey` case study

Worth singling out, because it shows how a _good_ seam can still be closed to
the case that matters.

`lib/app/rate-limit.ts` is a fork-owned registry seam. A fork can call
`registerRateLimitTier()` and `registerRateLimitRule()` — genuinely useful, and
listed in `VERSIONING.md`'s public surface. But:

```ts
// lib/security/rate-limit-policy.ts:44
export type RateLimitKey = 'ip' | 'session-user' | 'api-key' | 'embed-token';
```

`tier` is deliberately open (`RateLimitTier | (string & {})`). **`key` is a
closed union**, and it is consumed by a `switch` in
`lib/security/rate-limit-middleware.ts:250`. So a fork can register an org-scoped
_rule_ but cannot express an org-scoped _key_ — the exact thing per-tenant quota
enforcement requires. The seam is one type-widening and one registry away from
covering it.

**Generalisable lesson: a registry seam is only as open as its narrowest type.**
Worth auditing the other seams in `VERSIONING.md` for the same pattern before
declaring them fork-ready.

### Seam design principles

Distilled from the Daybreak fork's `canRead` / `subjectScope` work (documented
on #367) and from what the plane analysis implies:

1. **Async from day one.** Even where today's implementation is synchronous, a
   real team/grant lookup hits the database. Making the predicate
   `Promise`-returning up front avoids a sync→async sweep of every call site
   later.
2. **Two faces, one policy.** A row predicate (`canRead`) and a `where`-fragment
   (`subjectScope`) must be derivable from the same policy, with a parity test
   asserting they agree for every principal/resource pairing. A code review in
   Daybreak caught these diverging for admin-support viewers — build the parity
   into the API rather than leaving callers to reconcile.
3. **Open struct, not positional args.** `{ ownership?, tier?, org? }` means
   widening `own → team → all` or adding the tier axis is supplying an input to
   an existing predicate, not a signature change.
4. **Inert by default.** Same philosophy as `TENANCY_MODE`: at `single` the seam
   is a no-op and single-tenant installs pay nothing. This is what makes
   platform-tier seams politically cheap to land.
5. **Chokepoint, not sweep.** `lib/db/client.ts` is the model: one module,
   ~575 inheritors. Where a chokepoint already exists, widen it; do not add a
   parallel path.
6. **Fail closed, and fail loud.** The `TENANCY_MODE=multi` throw is the right
   pattern — a half-finished retrofit should refuse to boot rather than run
   unscoped.
7. **Enforce inventories with tests, not prose.** See [§12](#12-documentation-drift).

### Provisions upstream should ship

[§7](#7-ownership-platform-tier-vs-fork-tier) says what is platform-tier _if MT
is ever built_. This is the narrower and more actionable question: **what should
Sunrise ship for its forks even though Sunrise itself will never be
multi-tenant?** Everything below is inert at `TENANCY_MODE=single`, costs a
single-tenant install nothing, and converts a permanent fork conflict into a call
site.

| Provision                                                                                            | The fork conflict it removes                                                                                                      | Size                   |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `rlsEnabled(table)` / `policyExists(table, policy)` factories in `lib/db/drift-probes.ts`            | Hand-written `pg_policies` SQL re-derived in every fork                                                                           | Hours                  |
| Org (or install) id in `getFullContext()` (`lib/logging/context.ts`)                                 | `lib/logging/context.ts`                                                                                                          | Hours                  |
| Correct `VERSIONING.md`'s tenancy-seam path (see below)                                              | A fork looking for a module that was never shipped                                                                                | Minutes                |
| Widen `RateLimitKey` and add a key-resolver registry                                                 | `rate-limit-policy.ts` + `rate-limit-middleware.ts`                                                                               | Small                  |
| Optional scope dimension on `SUBJECT_DATA_SOURCES` / `collectAppSubjectData`                         | Per-org export re-invented per fork ([§5B](#portability-the-cheap-substitute-for-rungs-34))                                       | Small                  |
| Tenant-context primitive — ALS entered in `withAuth`/`withAdminAuth`, explicit per-job context       | `guards.ts`, `run-tick.ts` — **and it gates every row below** ([§5A.1](#5a1-the-prerequisite-there-is-no-tenant-context-to-pass)) | Medium                 |
| `resolveProviderCredential(config, ctx)`, defaulting to today's `process.env` lookup                 | `provider-manager.ts` ([§5C](#the-seam-that-avoids-choosing-now))                                                                 | Small, once ctx exists |
| `getStorageClient(ctx)` over the existing `StorageProvider` interface                                | `lib/storage/client.ts` ([§5B](#the-one-change-that-keeps-the-ladder-reachable))                                                  | Small, once ctx exists |
| Scope key on the process caches (settings resolver, breaker, in-flight counter), defaulting `global` | Six orchestration core files                                                                                                      | Medium                 |
| Authorization predicate + ownership resolver (#366/#367)                                             | `guards.ts`, `utils.ts`                                                                                                           | Tracked, blocked       |

Three of these are hours of work and remove three named files from the
twenty-file merge surface. The tenant-context primitive gates most of the rest,
which is why [§10](#10-sequencing-shape) puts it at Phase 0c and why it is the
one to do first if only one gets done.

**Publish each in `VERSIONING.md`'s public surface as it lands.** An undocumented
seam is one a fork cannot rely on across releases, and a fork that cannot rely on
a seam copies the file instead — which is the outcome all of this exists to
avoid. **One correction that preceded all of it (fixed 2026-09-01):**
`VERSIONING.md` named the tenancy seam `lib/tenancy/client.ts`; that file never
existed and the seam is `lib/db/client.ts` ([§12](#12-documentation-drift)).

### The standing obligation after MT ships in a fork

Provisions cover the build. The decay is the other half, and it has no owner
today. A fork's isolation boundary is correct only against the release it was
built on: upstream ships single-tenant and runs no policy tests, so any release
can add a model, a raw SQL site, a process-global cache or a background job that
lands outside the boundary — silently, because a clean merge looks like a clean
merge.

The fork-side answer is the per-sync checklist now carried in the playbook
([Keeping the retrofit alive across upstream syncs](./multi-tenancy.md#keeping-the-retrofit-alive-across-upstream-syncs)):
diff for new models, new `$queryRaw*` sites, new process-global state and new
jobs, then run the two-tenant harness. The upstream-side answer is
[§12](#12-documentation-drift)'s two enforcement tests — a raw-SQL allowlist and
a schema-derived policy-coverage assertion. **Both are worth more to forks than
to the platform**, which is the argument for shipping them upstream (inert at
`single`) instead of leaving every fork to rediscover the need after its first
leak.

### Guidance for fork authors, today

**Do now, safely:**

- Build the ownership-scope layer fork-locally in its final generic shape (the
  Daybreak pattern), so delegating to the upstream resolver later is a deletion.
- Keep `orgId` additions in your own schema files where the fork tiers allow.
- Namespace your storage keys by org from the first upload, even without
  enforcement — retrofitting key layout across existing objects is painful.
- Put org in your own log context wrappers.
- Write the two-tenant leakage harness early. It is the cheapest thing on this
  list and the only one that catches regressions in all the others.
- Register a drift probe per RLS policy in `lib/app/db-drift.ts` in the same
  change that creates the policy. `migrate dev` drops what Prisma cannot model,
  and the drop is invisible to a schema-only test suite.
- Put your tenancy modules in the tier that owns the tenant concept —
  `lib/framework/` if you are a framework fork, `lib/app/` if you are a leaf —
  and route everything you can through the existing registries above rather than
  through a core edit.
- Adopt the per-sync checklist as part of your upgrade ritual from the first
  release you merge, not the first leak you find.

**Wait for upstream, or accept a permanent conflict:**

- Guard signatures and the authorization predicate (#366/#367).
- Rate-limit key space.
- Process-cache keying and background-job tenancy.
- Slug-route resolution.

**Do not:**

- Do not fork `lib/auth/guards.ts`. It is the single chokepoint that makes the
  eventual upstream seam a drop-in; a local copy converts a one-line future
  change into a permanent divergence.
- Do not reflexively add `orgId` to the admin-authored global config models. The
  playbook is right that this is a product decision per model, and the
  reflexive sweep creates work that is hard to reverse.
- Do not run background jobs on a `BYPASSRLS` role without an explicit, audited,
  documented decision — it is the path of least resistance and it silently
  undoes the isolation guarantee.
- Do not put tenancy machinery in `lib/app/` if you are a **framework** fork.
  That tier belongs to your leaf forks; use `lib/framework/`.

### Fork-first informs upstream

The working model demonstrated on #367 is worth stating as policy: a fork that
needs a seam before it lands builds it **in its final generic shape** locally,
then feeds the contract back so the upstream version composes down cleanly. The
fork gets unblocked, upstream gets a design validated against real use rather
than speculation, and the eventual migration is a delegation plus a deletion.

The prerequisite is that the fork resists the temptation to build the _specific_
thing it needs. `canRead(viewer, subject, scope)` with an unused `tier` field is
harder to write than `isOwner(userId, row)` and is the reason the contract
transfers.

---

## 9. Deployment topologies

Worth stating plainly, because "make Sunrise multi-tenant" often means "avoid
running many instances" and that trade is not obviously in MT's favour.

| Topology                            | Isolation planes needed  | Cost                                                         | Good fit                                          |
| ----------------------------------- | ------------------------ | ------------------------------------------------------------ | ------------------------------------------------- |
| **Instance per tenant** (today)     | none                     | N deployments, N databases, N upgrade windows                | Few, large, high-trust tenants; regulated markets |
| **Database per tenant, shared app** | 3, 4, 5 (not 1, 2)       | Connection management, N migrations, tenant→DSN routing      | Tens of tenants; strong isolation story to sell   |
| **Schema per tenant, shared DB**    | 3, 4, 5 (**not** 1 or 2) | `search_path` discipline, migration fan-out, catalogue bloat | Tens to low hundreds; the under-examined middle   |
| **Pooled, RLS** (playbook's target) | **all five**             | Everything in §5                                             | Many small tenants; self-serve signup; low ARPU   |
| **Bridge** (pooled + siloed tier)   | all five, twice          | Both models maintained simultaneously                        | Mixed market with an enterprise tier              |

**This table under-sells the middle two rows, and that matters.** It is written
from the pooled-RLS point of view — planes are counted as work to be done rather
than as work a topology removes. [§5A.4](#5a4-the-three-way-comparison)
re-does the comparison on even terms, and schema-per-tenant comes out
considerably better than one line of "`search_path` discipline" suggests: it
removes plane 2 outright, removes the `orgId` migration and the policy-coverage
burden, and hands you per-tenant backup and per-tenant embedding models as side
effects.

Three observations:

- **Database-per-tenant eliminates planes 1 and 2 entirely** — the two the
  playbook and the constraint sweep address — at the cost of operational fan-out.
  Planes 3, 4 and 5 remain, and are the _untracked_ ones. So it reduces the
  documented work while leaving the undocumented work intact. Forks choosing it
  on the strength of the playbook alone will be surprised.
- **The "instance per tenant" row is the cell model without a control plane.**
  Add one — tenant registry, routing, provisioning pipeline — and the row turns
  from an operational burden into an architecture that hands you §5B's rungs
  2–4 and §5C's B2/B3 without building any of them.
  [§5A.3](#5a3-cells-sunrise-is-already-one).
- **Instance-per-tenant remains the right answer for a lot of forks**, and is
  Sunrise's current recommendation. The retrofit is justified by tenant count and
  self-serve signup, not by preference.

---

## 10. Sequencing shape

Not a commitment; the dependency order if it were built.

**Phase −1 — Topology.** Pooled RLS, schema-per-tenant, or cells
([§5A.4](#5a4-the-three-way-comparison)). This precedes every decision below,
because two of the three answers make phases 2–5 substantially or entirely
unnecessary. See [§14](#14-the-recommendation).

**Phase 0a — The unconditional work.** Five items needed under **every**
topology, and therefore the only work that can start before Phase −1 is
answered: org in the log/trace context; org-level export and erase; org-prefixed
storage keys; an org claim in storage access tokens; and a per-tenant data export
([§5B](#portability-the-cheap-substitute-for-rungs-34)). Two defects belong here
too, because they are wrong today rather than wrong under tenancy: the
[auto-fallback to unauthorised providers](#the-auto-fallback-defect), and
`AiCostLog`'s orphaning attribution chain.

**Phase 0b — Decisions.** §6's five decisions. Nothing below can be sized first.

**Phase 0c — The tenant-context primitive.**
[§5A.1](#5a1-the-prerequisite-there-is-no-tenant-context-to-pass). Absent from
the original sweep and blocking every seam in §5B/§5C. Required under pooled RLS
and schema-per-tenant; **not required under cells.**
`withAuth`/`withAdminAuth` covers the whole HTTP surface in two edits;
background jobs get no ambient answer and need an explicit per-job context.

**Phase 1 — Control plane (unblocks everything).** #366 + #367: injectable
predicate, resource resolver, `role` constants, API-key scope decision.
Delivers value at `TENANCY_MODE=single` for bespoke single-tenant forks — which
is why the #366 comment argues for decoupling it from tenancy mode, and why it
is the cheapest place to start.

**Phase 2 — Tenant identity.** `Org`/`OrgMembership`, session, resolution
strategy, lifecycle, per-org bootstrap.

**Phase 3 — Row + namespace planes.** `orgId` columns, RLS migration, role
split, composite uniques, slug-route redesign. **Phases 3 and 4 must land
together** — a scheduler running on a bypass role while RLS is enabled is worse
than either alone, because it looks isolated and is not.

**Phase 4 — Temporal + process planes.** Job tenancy and fairness, cache keying,
breaker/counter policy, singleton de-singletoning.

**Phase 5 — External plane.** Per-tenant credentials, per-org backup, and the
per-tenant eligible-provider policy that processing residency, sub-processor
disclosure and safe fallback all depend on
([§5C](#processing-residency-data-retention-and-the-sovereign-seam)). The five
unconditional items were pulled forward to Phase 0a. Rungs 2–4 of the storage
ladder and credential models C–F are product-tier decisions that hang off this
phase, not prerequisites for it.

**Phase 6 — Commercial plane.** Plans, quotas in the rate-limit key space,
metering rollups, invoicing.

**Phase 7 — Admin console split and impersonation.**

**Continuous — Assurance.** The two-tenant harness and the policy-coverage test
should land _with Phase 3_, not after. They are the only defence against every
subsequent phase silently regressing the boundary.

**What a fork can start before upstream answers anything.** The phases above
assume the platform is doing the work; a fork cannot wait for Phase −1 to be
answered by someone else, so its split is different:

| Phase                             | A fork should…                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0a — unconditional work           | **Start now.** All seven items live in fork-owned files or in code you already own, and they pay off single-tenant                                 |
| 0b/−1 — decisions and topology    | **Answer locally.** These are your product's decisions, not upstream's                                                                             |
| 0c — tenant context               | **Build in final generic shape.** Entering it in your own wrapper around `withAuth` keeps the eventual upstream primitive a delegation             |
| 1 — control plane (#366/#367)     | **Wait, or build generic.** Do not copy `lib/auth/guards.ts`; a local copy converts a one-line future change into permanent divergence             |
| 2–3 — identity, rows, namespace   | **Yours anyway.** `Org`/`OrgMembership` and the `orgId` migration ride your schema; the playbook is the recipe                                     |
| 4–5 — process, temporal, external | **Build generic, expect conflicts.** These are the twenty-file merge surface; each upstream provision that lands deletes one of your local edits   |
| 6–7 — commercial, console split   | **Yours** (commercial) and **wait** (console split — one tree behind one guard today)                                                              |
| Continuous — assurance            | **Start with Phase 3, plus the per-sync checklist.** The harness is the only thing that fails when an upstream release lands outside your boundary |

---

## 11. Risk register

Ranked by (impact × likelihood × how long it stays undetected).

| #   | Risk                                                                                                           | Plane | Detectability                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Background jobs run on a bypass role; a job bug crosses tenants                                                | 4     | **None** — looks correct, is not                                                                                                                                                            |
| 2   | Process cache serves tenant A's config to tenant B                                                             | 3     | **None from the database**                                                                                                                                                                  |
| 3   | Per-tenant provider credentials cached by slug alone — tenant A's authenticated client serves tenant B         | 3     | **None from the database** — the concrete form of risk #2 ([§5C](#5c-provider-credentials-and-per-tenant-ai-configuration))                                                                 |
| 4   | New raw SQL added post-retrofit without policy coverage                                                        | 1     | None without a lint rule                                                                                                                                                                    |
| 5   | Storage key collision or leaked signed URL crosses tenants                                                     | 5     | None — outside Postgres                                                                                                                                                                     |
| 6   | Missed `orgId` on one child table                                                                              | 1     | Only with a two-tenant harness                                                                                                                                                              |
| 7   | **Auto-fallback routes a tenant's prompts to a provider they never authorised** — live today, not hypothetical | 5     | **None** — it only fires on provider failure, and nothing inspects which provider served a turn ([§5C](#the-auto-fallback-defect))                                                          |
| 8   | Custody of tenants' vendor API keys with no envelope-encryption layer                                          | 5     | Only at breach time, when the blast radius is the tenant's cloud account ([§5C](#5c-provider-credentials-and-per-tenant-ai-configuration))                                                  |
| 9   | Slug collision blocks a customer; error leaks existence                                                        | 2     | Immediate but only in production — **removed outright by schema-per-tenant** ([§5A.2](#5a2-schema-per-tenant-the-option-9-dismisses-in-one-line))                                           |
| 10  | Shared circuit breaker couples tenant failure domains                                                          | 3     | Visible as unexplained cross-tenant outages                                                                                                                                                 |
| 11  | A bespoke per-tenant storage arrangement agreed in a sales cycle                                               | 5     | Immediate, and expensive — migrations, backup, DR, retention, Art. 15 export and vector search each need a per-backend variant ([§5B](#5b-data-handling-residency-and-storage-flexibility)) |
| 12  | One tenant exhausts `globalMonthlyBudgetUsd`                                                                   | Comm. | Immediate, total                                                                                                                                                                            |
| 13  | Scheduler starvation from a heavy tenant                                                                       | 4     | Visible as "our schedules are late"                                                                                                                                                         |
| 14  | Controller/processor obligations unaddressed                                                                   | Priv. | At audit or first subject request                                                                                                                                                           |
| 15  | Residency answered for storage but not for inference or embeddings                                             | 5     | At audit — the storage answer looks complete and is not ([§5B](#residency-covers-processing-not-just-storage))                                                                              |

Risks 1–5 and 7 share a property that should drive the sequencing: **they are
invisible to the mechanism that makes MT trustworthy.** RLS is a strong control
precisely because it fails closed — and none of them are governed by it.

Risk 7 is the odd one out in a useful way: it is the only entry that is a defect
in the code **today** rather than a consequence of tenancy. It costs almost
nothing to fix now and becomes a compliance finding later.

---

## 12. Documentation drift

Three concrete drifts found while verifying, and one recommendation.

| Drift                                                                                                                                                                                               | Where                    | Status               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------- |
| "The schema has **60 models**" — it now has **61**                                                                                                                                                  | `multi-tenancy.md`       | **Fixed** 2026-08-07 |
| Raw-SQL table lists 6 files; Appendix A found 3 more, and by v0.11.2 the app-layer inventory had grown again (~15 request-path sites) — the allowlist guard test, once landed, is the living record | `multi-tenancy.md:47-54` | Open                 |
| `lib/tenancy/client.ts` named as a covered seam; the file does not exist (the seam is `lib/db/client.ts`)                                                                                           | `VERSIONING.md:75`       | **Fixed** 2026-09-01 |

None is serious in isolation. Together they make the point: **a hand-maintained
inventory of security-relevant sites drifts within months** — the model count
drifted while this very document was being written, which is the argument in
miniature. The raw-SQL table is
the one that matters — it is the list of places RLS is doing the load-bearing
work, and a new entry that nobody notices is exactly risk #3.

**Recommendation.** Enforce it the way this repo already enforces the privacy
manifest. `tests/unit/lib/privacy/export-sources.test.ts` parses the schema and
fails the build when a model is added without an export disposition, and
`CLAUDE.md` forbids deleting from the manifest to make the test pass. The same
shape applies here:

- A test that greps for `$queryRaw*` outside an allowlist and fails on new
  entries.
- A test that parses the schema, derives the tenant-owned model list, and (under
  `TENANCY_MODE=multi`) asserts RLS is enabled with a policy on each.
- A `policyExists` / `rlsEnabled` probe factory in `lib/db/drift-probes.ts`, so
  a fork's per-table policy assertions are a one-liner in `lib/app/db-drift.ts`
  instead of hand-rolled catalog SQL
  ([§8](#provisions-upstream-should-ship)).

All three are cheap, all three fail loudly, and all three survive the author
leaving. **They are worth more to forks than to the platform** — upstream is
single-tenant, so the policy-coverage test is a no-op at `TENANCY_MODE=single`
and the raw-SQL allowlist is useful on its own terms, while for a fork running
RLS they are the difference between a boundary that holds across releases and one
that quietly decays. That asymmetry is the argument for shipping them upstream
rather than leaving each fork to write them after its first leak.

---

## 13. Open questions

[§14](#14-the-recommendation) proposes answers to six of these and explains why
the rest cannot be answered from here.

0. **Pooled RLS, schema-per-tenant, or cells?** The question that precedes every
   other one ([§5A.4](#5a4-the-three-way-comparison)). Sunrise's single-tenant
   install is already a well-formed data-plane cell; what is missing is a control
   plane, which is a separate system. Under a cell answer most of §5 is not the
   right work, and under schema-per-tenant a large part of it is not either.
1. **Multi-org membership?** (§6 — blocks #366 and #367.)
2. **Tenant resolution strategy?** Propagates further than any other decision
   and is currently unowned by any issue.
3. **Are the two singletons per-tenant?** If yes, that is a larger change than
   the playbook's "opt-in product decision" framing suggests — and it is what
   gates per-tenant default models and budgets
   ([§5C](#5c-provider-credentials-and-per-tenant-ai-configuration), B3).
   Sub-question: can two tenants use **different embedding models**? That is a
   vector-dimension question, not a settings question.
4. **Do breakers and in-flight counters go per-tenant?** Per-tenant protects
   neighbours; global gives a better failure signal. Genuine trade-off.
5. **Shared provider credentials with quotas, or per-tenant BYO keys?** Four
   models are compared in
   [§5C](#5c-provider-credentials-and-per-tenant-ai-configuration). The prior
   question is whether Sunrise is willing to become a **custodian of other
   companies' vendor credentials** — that is a security-posture decision, and
   answering it "no" makes the gateway and vault-reference models the only
   candidates.
6. **Does the `admin` API-key scope gain an org dimension, or is it declared
   platform-only?** (#366 secondary decision, still open.)
7. **Is the impersonation/support-access model in scope for the platform, or
   left to forks?** It is a compliance surface, which argues for platform.
8. **Should Phase 1 be decoupled from `TENANCY_MODE` entirely?** The #366
   comment argues yes — bespoke single-tenant forks need the operator-tier and
   ownership axes with no tenancy at all, which makes them the cheaper, earlier
   validation of the same seam.
9. **How far up the storage ladder does Sunrise commit?**
   ([§5B](#5b-data-handling-residency-and-storage-flexibility).)
   Publishing the ladder is itself the deliverable; the engineering question is
   only where the published line sits. Rung 5 (dedicated deployment) already
   ships.
10. **Is `AiCostLog` given a tenant column, or is attribution left to the
    nullable `SetNull` FK chain?** Today deleting an agent orphans its cost
    history, which is tolerable for reporting and not tolerable for billing.
11. **How is tenant context carried?**
    ([§5A.1](#5a1-the-prerequisite-there-is-no-tenant-context-to-pass).)
    `AsyncLocalStorage` entered in `withAuth`/`withAdminAuth` covers HTTP;
    background jobs need an explicit answer, and "it defaults to no tenant" is
    the wrong one. Sub-question: does the resolver throw when
    `TENANCY_MODE=multi` and no context is set?
12. **Does `BETTER_AUTH_SECRET` stay a single install-wide key?** It currently
    signs sessions, email-change JWTs, storage access tokens and approval
    tokens. Per-tenant key material — and a rotation story that does not
    invalidate all four at once — is a prerequisite for any credible
    key-management answer.
13. **Is a per-tenant data export committed to?**
    ([§5B](#portability-the-cheap-substitute-for-rungs-34).) It is the cheapest
    answer to most "we must control our own data" requests, it is valuable under
    every topology, and today's exporter covers configuration only.
14. **Do provider and model rows gain a jurisdiction attribute, and is it
    enforced?** ([§5C](#processing-residency-data-retention-and-the-sovereign-seam).)
    The `deploymentProfiles` vocabulary already exists and nothing reads it as
    policy. Without this, a residency answer covers storage and silently omits
    inference and embeddings.
15. **Is the auto-fallback behaviour changed to default-deny under tenancy, or
    is unauthorised failover accepted and disclosed?**
    ([§5C](#the-auto-fallback-defect).) This one has a deadline the others do
    not: it is wrong in the code today.

---

## 14. The recommendation

Everything above is deliberately even-handed. Even-handedness is also the safe
option — it cannot be wrong — so this section states a position. It is a
recommendation, not a decision; the decision belongs to whoever owns the
roadmap. Where the evidence does not support a position, that is said rather
than hedged into one.

### 14.1 What to do about the asks that prompted Part II

**Answer enterprise data-control demands with a dedicated instance, not with a
pooled retrofit.** A prospect asking for their own storage, their own encryption
keys, their own provider credentials and their own model defaults is describing
[§5A.3](#5a3-cells-sunrise-is-already-one)'s cell, item by item. Sunrise already
ships that. Building pooled multi-tenancy in response is answering the question
with the topology that serves it worst — several quarters of platform-tier work
to reach a weaker version of what a `docker compose up` already provides.

**Publish the ladder as a tier list.** "Shared → own region → own key → own
database → own deployment", with rung 6 explicitly excluded. This converts an
unbounded architectural question into a price list, and it is a sales asset
rather than a concession. Do this before the next enterprise conversation, not
after.

**Diagnose portability before costing residency.** A large share of "we must
control our own data" is "we must be able to leave"
([§5B](#portability-the-cheap-substitute-for-rungs-34)). Sunrise cannot answer
it today — the exporter covers configuration only. A per-tenant export is small,
it is valuable under every topology, and it frequently closes the deal that a
residency guarantee was being demanded to close.

**Decline credential custody as policy.** Do not hold tenants' vendor API keys
in Sunrise's database. Prefer, in order: the cell's own environment (F),
workload identity federation where the tenant is on AWS or GCP (E), a gateway
with virtual keys (D), a reference into the tenant's own secret manager (C).
Model B is the one that looks cheapest and permanently changes what a breach of
your database means. Writing this down as a policy is what stops it being
decided under deal pressure.

### 14.2 If pooling is chosen anyway

**Evaluate schema-per-tenant before committing to RLS.**
[§5A.2](#5a2-schema-per-tenant-the-option-9-dismisses-in-one-line) sets out the
case: it uses the playbook's own per-transaction `set_config` discipline, and it
removes plane 2 entirely, the `orgId` migration across ~30 models, the permanent
policy-coverage burden, and the per-tenant-embedding-model blocker — while
handing you `pg_dump --schema` as backup, restore and export. The costs are
migration fan-out and a ceiling in the low hundreds of tenants. **For the tenant
count most Sunrise forks will actually have, that trade favours schemas.**

This is not a recommendation to abandon the playbook. The playbook is correct
and proven for the topology it assumes. It is a recommendation to **spike
schema-per-tenant against Prisma 7 before assuming RLS**, the same way the RLS
pattern itself was spiked. The specific thing to verify is that Prisma emits
unqualified table names so `search_path` routing works; if that fails, RLS is
the answer and the spike cost a day.

If pooled RLS is chosen, nothing in the playbook changes and §10 applies as
written.

### 14.3 Do these regardless of the answer

Seven items are worth doing under **every** topology, including staying
single-tenant. They are Phase 0a in [§10](#10-sequencing-shape).

| Item                                         | Why it is unconditional                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Org (or install) id in the log/trace context | Turns breach scoping and audit evidence from reconstruction into lookup                  |
| Org-level export and erase entry points      | The manifest exists; adding a dimension is far cheaper than building it later            |
| **Per-tenant data export**                   | The portability answer; currently impossible — config only                               |
| Org-prefixed storage keys                    | Retrofitting key layout across existing objects is painful and gets worse monotonically  |
| Org claim in storage access tokens           | A signed URL is a bearer token with no tenant claim today                                |
| **Fix the auto-fallback default**            | [A live defect](#the-auto-fallback-defect) that routes prompts to unauthorised providers |
| **Give `AiCostLog` a durable owner column**  | `SetNull` orphaning makes cost history unusable for billing or attribution               |

The last two are not tenancy work at all — they are current defects that tenancy
would promote into compliance findings.

Two more are cheap and pay off immediately: a **jurisdiction attribute on
provider and model rows** (the `deploymentProfiles` vocabulary already exists and
nothing enforces it), and the **two-tenant leakage harness**, which is the only
control that keeps every other item fixed.

### 14.5 What to commit to for forks, regardless of Question B

[§2](#2-the-two-questions)'s Question B — should Sunrise itself be multi-tenant —
can stay unanswered indefinitely, and [§14.1](#141-what-to-do-about-the-asks-that-prompted-part-ii)
argues the enterprise asks are better answered with a cell than with a pooled
retrofit. Question A cannot be deferred the same way: forks are retrofitting MT
now, against a template that ships single-tenant, and every gap they hit becomes
a copied core file that never merges cleanly again.

**The position: commit to the seams, not to the feature.** Ship the provisions in
[§8](#provisions-upstream-should-ship). Each is a no-op at `TENANCY_MODE=single`,
each deletes a named file from the twenty-file merge surface, and together they
move the "can a fork retrofit MT without fighting upstream?" figure in
[§1](#1-executive-summary) without Sunrise building any tenancy at all. Three are
hours of work — the drift-probe factories, org in the log context, and the
`VERSIONING.md` path correction. The tenant-context primitive gates most of the
rest and is the one to do first.

**And write the contract down, not just the recipe.** A fork author needs three
things the playbook did not previously state: where tenancy code lives in their
tier, which core edits are sanctioned, and what they must re-check on every
upstream sync. Those are now the playbook's
[fork-tier map](./multi-tenancy.md#where-a-forks-tenancy-code-lives) and
[sync checklist](./multi-tenancy.md#keeping-the-retrofit-alive-across-upstream-syncs).
Keeping two short sections current is cheaper than answering the same question
once per fork — and cheaper still than the alternative, which is a fork
discovering the answer from a leak.

**What this does not commit to.** None of it says Sunrise will ever have an `Org`
table, and none of it should be read as a step toward one. A provision that only
makes sense if MT lands upstream does not belong on the §8 list; the test is
whether the seam is defensible at `TENANCY_MODE=single` on its own terms. All ten
are.

### 14.4 Questions this document can answer, and questions it cannot

Of the open questions in [§13](#13-open-questions), these have defensible
answers on the evidence assembled here:

| Question                            | Recommended answer                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topology (Q0)                       | Cells for enterprise demand; spike schema-per-tenant before RLS if pooling                                                                               |
| Storage ladder commitment (Q9)      | Publish rungs 0–5; exclude rung 6                                                                                                                        |
| Credential custody (Q5)             | No. Models F/E/D/C in that order                                                                                                                         |
| `AiCostLog` tenant column (Q10)     | Yes — and it is worth doing single-tenant                                                                                                                |
| Tenant context mechanism (Q11)      | ALS entered in `withAuth`/`withAdminAuth`; explicit per-job context for background work; resolver throws when `TENANCY_MODE=multi` and context is absent |
| Phase 1 decoupled from tenancy (Q8) | Yes — #366/#367 deliver value at `TENANCY_MODE=single`                                                                                                   |

These genuinely cannot be answered from here, because they are product or
commercial decisions rather than technical ones:

- **Multi-org membership (Q1)** — depends on what the product sells.
- **Tenant resolution strategy (Q2)** — depends on the brand and domain model.
- **Breakers and counters per-tenant (Q4)** — a real trade-off with no dominant
  answer; decide with an SLA in hand.
- **Impersonation ownership (Q7)** — a legal and support-model question.

**The one thing this document should not be read as saying** is that Sunrise
should ship multi-tenancy. [§2](#2-the-two-questions)'s Question B is untouched
by everything above. The recommendation is about how a fork — or the platform,
if it ever answers B yes — should approach it, and about the handful of items
worth building before anyone answers anything.

---

## Appendix A — Raw SQL sites

Verified at `b7e30f06`. The playbook's table covers rows 1–5 plus the exempt
health check; rows 6–8 are app-layer sites it does not list.

| #   | File                                                                                 | Line(s)       | Method                                  |
| --- | ------------------------------------------------------------------------------------ | ------------- | --------------------------------------- |
| 1   | `lib/orchestration/knowledge/search.ts`                                              | 354, 447      | `$queryRawUnsafe` (pgvector)            |
| 2   | `lib/orchestration/knowledge/document-manager.ts`                                    | 160           | `$executeRawUnsafe`                     |
| 3   | `lib/orchestration/knowledge/seeder.ts`                                              | 138, 237, 256 | `$queryRawUnsafe` / `$executeRawUnsafe` |
| 4   | `lib/orchestration/chat/message-embedder.ts`                                         | 87            | `$executeRawUnsafe`                     |
| 5   | `lib/orchestration/llm/cost-reports.ts`                                              | 185, 321      | `$queryRawUnsafe`                       |
| 6   | `app/api/v1/chat/stream/route.ts`                                                    | 140           | raw                                     |
| 7   | `app/api/v1/admin/orchestration/conversations/search/route.ts`                       | 143           | `$queryRawUnsafe`                       |
| 8   | `app/api/v1/admin/orchestration/evaluations/datasets/[id]/cases/[position]/route.ts` | 70            | raw                                     |
| —   | `lib/db/utils.ts`                                                                    | 14, 41        | `SELECT 1` health check — exempt        |

Scripts (out of request path, but run against production data in some setups):
`scripts/embeddings-reset.ts`, `scripts/smoke/knowledge-hybrid-search.ts`,
`scripts/test-knowledge-base.ts`.

## Appendix B — Unique constraints requiring an org composite

Human-meaningful or routing-relevant constraints only; key hashes and
already-scoped composites omitted.

| Model                     | Constraint                                    | File:line                               |
| ------------------------- | --------------------------------------------- | --------------------------------------- |
| `AiAgent`                 | `slug @unique`                                | `orchestration-agents.prisma:9`         |
| `AiAgentProfile`          | `slug @unique`                                | `orchestration-agents.prisma:147`       |
| `AiCapability`            | `slug @unique`                                | `orchestration-agents.prisma:226`       |
| `AiWorkflow`              | `slug @unique`                                | `orchestration-workflows.prisma:10`     |
| `AiWorkflowTrigger`       | `@@unique([channel, workflowId])`             | `orchestration-workflows.prisma:133`    |
| `AiKnowledgeBase`         | `slug @unique`                                | `orchestration-knowledge.prisma:18`     |
| `AiKnowledgeDocument`     | `slug @unique`                                | `orchestration-knowledge.prisma:57`     |
| `KnowledgeTag`            | `slug @unique`                                | `orchestration-knowledge.prisma:152`    |
| `AiKnowledgeChunk`        | `chunkKey @unique`                            | `orchestration-knowledge.prisma:121`    |
| `AiProviderConfig`        | `name @unique`, `slug @unique`                | `orchestration-providers.prisma:43-44`  |
| `AiProviderModel`         | `slug @unique`                                | `orchestration-providers.prisma:69`     |
| `AiOrchestrationSettings` | `slug @unique @default("global")` — singleton | `orchestration-providers.prisma:171`    |
| `FeatureFlag`             | `name @unique`                                | `platform.prisma:20`                    |
| `SeedHistory`             | `name @unique`                                | `platform.prisma:55`                    |
| `McpServerConfig`         | `slug @unique @default("global")` — singleton | `mcp.prisma:12`                         |
| `McpExposedPrompt`        | `name @unique`                                | `mcp.prisma:74`                         |
| `McpExposedResource`      | `uri @unique`                                 | `mcp.prisma:97`                         |
| `AiOutboundMessage`       | `dedupKey @unique`                            | `orchestration-conversations.prisma:67` |
| `AiWorkflowExecution`     | `@@unique([dedupKey])`                        | `orchestration-workflows.prisma:245`    |
| `AiWorkflowStepDispatch`  | `idempotencyKey @unique`                      | `orchestration-workflows.prisma:280`    |

Already tenant-safe once the parent carries `orgId`:
`@@unique([agentId, channel, fromAddress])`, `@@unique([agentId, version])`,
`@@unique([agentId, capabilityId])`, `@@unique([workflowId, version])`,
`@@unique([datasetId, position])`, `@@unique([runId, casePosition])`,
`@@unique([executionId, stepId])`, `@@unique([userId, agentId, key])`.

## Appendix C — Process-global state

| Module                                                             | State                    | Current key      |
| ------------------------------------------------------------------ | ------------------------ | ---------------- |
| `lib/orchestration/settings.ts:294`                                | `settingsCache`, 30s TTL | none             |
| `lib/orchestration/llm/settings-resolver.ts:55`                    | default-models map       | none             |
| `lib/orchestration/llm/circuit-breaker.ts:180`                     | `breakers` Map           | provider slug    |
| `lib/orchestration/llm/in-flight-counter.ts:24`                    | `counts` Map             | provider slug    |
| `lib/orchestration/llm/model-registry.ts` / `-db-hydrate.ts`       | hydrated registry        | none             |
| `lib/orchestration/llm/provider-manager.ts`                        | provider instances       | provider slug    |
| `lib/orchestration/provider-test-cache.ts`                         | connectivity results     | provider slug    |
| `lib/orchestration/mcp/{session,tool,prompt,resource}-registry.ts` | registries               | server-global    |
| `lib/orchestration/capabilities/dispatcher.ts`                     | dispatcher state         | needs audit      |
| `lib/orchestration/knowledge/resolveAgentDocumentAccess.ts`        | access cache             | agent            |
| `lib/orchestration/hooks/registry.ts`                              | hook registry            | none             |
| `lib/security/rate-limit-stores/memory.ts`                         | LRU of timestamps        | rate-limit token |
| `lib/orchestration/evaluations/run-claim.ts`                       | claim state              | needs audit      |
| `lib/orchestration/maintenance/platform-jobs.ts`                   | last-run times           | job name         |

Not exhaustive — the audit itself is Phase 4 work.

## Appendix D — Background jobs

Registered in `lib/orchestration/maintenance/platform-jobs.ts:103-162`; fork
extension point at `lib/app/jobs.ts`.

| Job                        | Interval   | Scope today                         |
| -------------------------- | ---------- | ----------------------------------- |
| `webhookRetries`           | every tick | global queue                        |
| `hookRetries`              | every tick | global queue                        |
| `orphanSweep`              | 2 min      | global lease reclamation            |
| `zombieReaper`             | 5 min      | global                              |
| `embeddingBackfill`        | 15 min     | global, batch 25                    |
| `retention`                | 1 hour     | global `deleteMany` across 8 tables |
| `pendingExecutionRecovery` | 2 min      | global                              |
| `evaluationRuns`           | every tick | global queue                        |

Plus `processDueSchedules()` (`lib/orchestration/scheduling/scheduler.ts:224`),
`take: 50` per tick, no tenant fairness.

## Appendix E — Global configuration and singletons

| Model                     | Shape                            | Playbook classification |
| ------------------------- | -------------------------------- | ----------------------- |
| `AiOrchestrationSettings` | **singleton**, `slug = "global"` | admin-authored global   |
| `McpServerConfig`         | **singleton**, `slug = "global"` | admin-authored global   |
| `AiProviderConfig`        | per-provider row                 | admin-authored global   |
| `AiProviderModel`         | per-model row                    | admin-authored global   |
| `AiCapability`            | per-capability row               | admin-authored global   |
| `AiAgentProfile`          | per-profile row                  | admin-authored global   |
| `AiAgentCapability`       | join                             | admin-authored global   |
| `FeatureFlag`             | per-flag row                     | admin-authored global   |
| `KnowledgeTag`            | per-tag row                      | admin-authored global   |
| `AuthBootstrap`           | **singleton**, install-scoped    | system                  |

## Appendix F — Tenant-relevant public routes

| Route                                                           | Auth              | Tenant arrives how?  |
| --------------------------------------------------------------- | ----------------- | -------------------- |
| `app/api/v1/chat/agents/[slug]/validate-token`                  | invite token      | undecided            |
| `app/api/v1/chat/stream`                                        | session / API key | undecided            |
| `app/api/v1/inbound/[channel]/[slug]`                           | HMAC signature    | undecided            |
| `app/api/v1/webhooks/trigger/[slug]`                            | API key           | undecided            |
| `app/api/v1/embed/chat/stream`                                  | embed token       | token could bind org |
| `app/api/v1/embed/widget-config`, `widget.js`, `speech-to-text` | embed token       | token could bind org |
| `app/api/v1/mcp/**`                                             | MCP API key       | key could bind org   |
| `app/api/v1/contact`                                            | none              | n/a — cross-tenant   |

The embed, MCP and API-key routes have a natural answer (bind the org to the
credential). The inbound and webhook routes do not — they are addressed by a
global slug and authenticated by a shared-secret signature.

---

## Related

- [`multi-tenancy.md`](./multi-tenancy.md) — the RLS playbook (data plane)
- [`overview.md`](./overview.md) — the single-tenant baseline
- [`../privacy/data-erasure.md`](../privacy/data-erasure.md) — the `onDelete`
  graph that doubles as the org-teardown dependency graph
- [`../privacy/data-export.md`](../privacy/data-export.md) — subject access and
  the test-enforced source manifest
- [`../orchestration/retention.md`](../orchestration/retention.md) — per-data-class
  retention that MT would make per-org
- [`../orchestration/scheduling.md`](../orchestration/scheduling.md) — the tick
  model that plane 4 has to make tenant-aware
- [`../security/rate-limiting.md`](../security/rate-limiting.md) — the policy
  table and its key space
- [`../admin/orchestration-providers.md`](../admin/orchestration-providers.md)
  — the env-var-only API-key security model that §5C has to trade away
- [`../storage/overview.md`](../storage/overview.md) — the `StorageProvider`
  interface §5B relies on for rungs 1–4
- [`../orchestration/cost-estimation.md`](../orchestration/cost-estimation.md)
  — pre-run estimates, the input to any per-tenant budget policy
- [`../../CUSTOMIZATION.md`](../../CUSTOMIZATION.md#the-appplatform-model) — the
  app/platform ownership model
- [`../../VERSIONING.md`](../../VERSIONING.md#public-surface-contract-tight-definition)
  — the public-surface contract
